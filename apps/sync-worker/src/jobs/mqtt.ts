import { getSettings } from '@spotify-to-plex/plex-config/functions/getSettings';
import { getById } from '@spotify-to-plex/plex-music-search/functions/getById';
import { plexHomeUserOf } from '@spotify-to-plex/plex-helpers/utils/plexSettingsFor';
import { PlexMusicSearchConfig } from '@spotify-to-plex/plex-music-search/types/PlexMusicSearchConfig';
import { SavedItem } from '@spotify-to-plex/shared-types/spotify/SavedItem';
import { PlaylistData } from '@spotify-to-plex/shared-types/dashboard/PlaylistData';
import { getNestedSyncLogsForType } from '../utils/getNestedSyncLogsForType';
import { startSyncType } from '../utils/startSyncType';
import { clearSyncTypeLogs } from '../utils/clearSyncTypeLogs';
import { completeSyncType } from '../utils/completeSyncType';
import { errorSyncType } from '../utils/errorSyncType';
import { updateSyncTypeProgress } from '../utils/updateSyncTypeProgress';
import { loadMQTTConfig } from '../services/mqtt/config';
import { createMQTTClient } from '../services/mqtt/createMQTTClient';
import { loadMQTTData } from '../services/mqtt/loadMQTTData';
import { findPlaylistPlexId } from '../services/mqtt/findPlaylistPlexId';
import { findAlbumPlexId } from '../services/mqtt/findAlbumPlexId';
import { extractPlexMediaId } from '../services/mqtt/extractPlexMediaId';
import { buildEntity } from '../services/mqtt/buildEntity';
import { createMQTTPublisher } from '../services/mqtt/createMQTTPublisher';
import { createEntityId } from '../services/mqtt/createEntityId';
import { createDiscoveryTopic } from '../services/mqtt/createDiscoveryTopic';
import { createStateTopic } from '../services/mqtt/createStateTopic';
import { getCategoriesDiscoveryTopic } from '../services/mqtt/getCategoriesDiscoveryTopic';
import { getCategoriesStateTopic } from '../services/mqtt/getCategoriesStateTopic';
import { loadPreviousItems } from '../services/mqtt/loadPreviousItems';
import { savePublishedItems } from '../services/mqtt/savePublishedItems';
import { findItemsToRemove } from '../services/mqtt/findItemsToRemove';
import { writeDryRunManifest } from '../services/mqtt/writeDryRunManifest';
import { PublishedItem, TrackLink, MQTTEntity } from '../services/mqtt/types';
import { PlexItemMissingError } from '@spotify-to-plex/plex-music-search/utils/PlexItemMissingError';
import { runExclusive } from "@spotify-to-plex/shared-utils/utils/syncLock";

/**
 * Main MQTT sync function
 * Publishes Plex playlist and album data to Home Assistant via MQTT Discovery
 */
export async function syncMQTT() {
    // A second start while a run is going - two clicks, or by hand during the scheduled run - ends at once
    return runExclusive('mqtt', () => runMQTT());
}

async function runMQTT() {
    // MQTT is optional and configured only by environment. Without a broker there
    // is nothing to publish to, and loadMQTTConfig throws - which happened above
    // the try block below, so the job never reached its error handler and sat
    // reporting "running" for ever. Skip before the log is even started.
    if (!process.env.MQTT_BROKER_URL?.trim()) {
        console.log('[MQTT] No MQTT_BROKER_URL configured, skipping');

        return;
    }

    // Start sync type logging
    startSyncType('mqtt');
    clearSyncTypeLogs('mqtt');

    const { putLog, logError, logComplete } = getNestedSyncLogsForType('mqtt');

    // Check for dry-run mode
    const isDryRun = process.env.MQTT_DRY_RUN === 'true';
    console.log('[MQTT] Starting MQTT publish job...');

    let client: ReturnType<typeof createMQTTClient> | undefined;
    // Set once the previous list is read: lists what the broker may still hold, once, however the run ends
    let saveList: (() => void) | undefined;

    // Everything after the start settles the status: a throw above this try left it "running" until the next run
    try {
        // Load MQTT configuration
        const mqttConfig = loadMQTTConfig();

        // Get Plex settings
        const settings = await getSettings();
        if (!settings.uri || !settings.token)
            throw new Error('No Plex connection found');

        const plexConfig: PlexMusicSearchConfig = {
            uri: settings.uri,
            token: settings.token
        };

        // Connect to MQTT broker (skip in dry-run mode)
        if (!isDryRun) {
            client = createMQTTClient(mqttConfig);

            try {
                await client.connect();
            } catch {
                console.error('[MQTT] ERROR: Failed to connect to MQTT broker');
                throw new Error('Failed to connect to MQTT broker');
            }
        }

        // Load data files
        const { savedItems, playlists, trackLinks } = loadMQTTData();

        console.log(`[MQTT] Processing ${savedItems.length} saved items with categories...`);

        // Load previously published items for cleanup
        const previouslyPublished = loadPreviousItems();
        const previousById = new Map(previouslyPublished.filter(published => published?.id).map(published => [published.id, published]));

        // Create MQTT publisher (only if not dry-run)
        let publisher = null;
        if (!isDryRun && client)
            publisher = createMQTTPublisher(client, mqttConfig.topicPrefix, mqttConfig.discoveryPrefix);

        // Process items
        const currentPublished: PublishedItem[] = [];
        const cleared = new Set<string>();
        if (!isDryRun) {
            saveList = () => {
                saveList = undefined;
                const held = new Set(findItemsToRemove(previouslyPublished, currentPublished).filter(id => !cleared.has(id)));
                savePublishedItems([...currentPublished, ...previouslyPublished.filter(item => item?.id && held.has(item.id))]);
            };
        }

        const categories = new Set<string>();
        let successCount = 0;
        let errorCount = 0;
        const countByType = { playlists: 0, albums: 0, 'plex-media': 0 };

        // For dry-run manifest
        const dryRunEntities: {
            entity: MQTTEntity;
            discoveryTopic: string;
            stateTopic: string;
            published: PublishedItem;
        }[] = [];

        for (let i = 0; i < savedItems.length; i++) {
            const item = savedItems[i];
            if (!item?.label)
                continue;

            // The broker is gone: every item left would only fail on its own
            if (client && !client.isConnected())
                throw new Error('Lost the connection to the MQTT broker');

            // Update progress
            updateSyncTypeProgress('mqtt', i + 1, savedItems.length);

            const itemLog = putLog(`mqtt_${item.id}`, item.title);
            // The entity a publish is sending: its config may reach the broker before the state fails,
            // so it is kept even when the last run had no entry for it
            let attempted: PublishedItem | undefined;
            // A failure that may pass - Plex down or slow, the broker refusing one publish - keeps the
            // entity Home Assistant already has, rather than the cleanup below deleting it. Only an
            // item Plex says it no longer has is gone for good.
            const keepUnlessGone = (error: unknown) => {
                if (error instanceof PlexItemMissingError)
                    return;

                const kept = previousById.get(item.id) ?? attempted;
                if (kept)
                    currentPublished.push(kept);
            };

            // Home Assistant plays as the Plex owner, who can't see a playlist made as a Home user: skipped
            // before its label is counted, and its old entity is removed by the cleanup below
            if (item.type === 'spotify-playlist' && await plexHomeUserOf(item.user)) {
                logComplete(itemLog);
                continue;
            }

            categories.add(item.label);

            try {
                // Determine Plex ID based on type
                const plexId = resolvePlexId(item, playlists, trackLinks);
                if (!plexId) {
                    console.warn(`[MQTT] Warning: No Plex ID found for ${item.type} "${item.title}" (${item.id}), skipping`);
                    logError(itemLog, `No Plex ID mapping found`);
                    errorCount++;
                    continue;
                }

                // Fetch Plex metadata
                const isPlaylist = item.type === 'spotify-playlist' || (item.type === 'plex-media' && item.uri?.includes('/playlists/'));
                const plexEndpoint = isPlaylist ? `/playlists/${plexId}` : `/library/metadata/${plexId}`;

                let plexMetadata;
                try {
                    plexMetadata = await getById(plexConfig, plexEndpoint);
                } catch (error) {
                    console.warn(`[MQTT] Warning: Failed to fetch Plex metadata for "${item.title}": ${error instanceof Error ? error.message : 'Unknown error'}`);
                    logError(itemLog, `Failed to fetch Plex metadata`);
                    errorCount++;
                    keepUnlessGone(error);
                    continue;
                }

                // Build entity
                const entity = buildEntity(item, plexId, plexMetadata.image || '');
                const published: PublishedItem = {
                    id: entity.id,
                    entity_id: createEntityId(entity.id, mqttConfig.topicPrefix),
                    category: entity.category,
                };

                // Publish entity or collect for dry-run
                if (isDryRun) {
                    // Collect entity data for manifest
                    const discoveryTopic = createDiscoveryTopic(published.entity_id, mqttConfig.discoveryPrefix);
                    const stateTopic = createStateTopic(entity.id, mqttConfig.topicPrefix);

                    dryRunEntities.push({ entity, discoveryTopic, stateTopic, published });
                    currentPublished.push(published);
                    console.log(`[DRY-RUN] Would publish: ${item.title} [${item.type}] (${item.label})`);

                }

                if (publisher) {
                    attempted = published;
                    await publisher.publishEntity(entity);
                    currentPublished.push(published);
                    console.log(`[MQTT] Published: ${item.title} [${item.type}] (${item.label})`);
                }

                // Update counters
                successCount++;
                switch (item.type) {
                    case 'spotify-playlist': {
                        countByType.playlists++;

                        break;
                    }
                    case 'spotify-album': {
                        countByType.albums++;

                        break;
                    }
                    case 'plex-media': {
                        countByType['plex-media']++;

                        break;
                    }
                }

                logComplete(itemLog);

            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                console.error(`[MQTT] Error publishing "${item.title}": ${message}`);
                logError(itemLog, `Failed to publish: ${message}`);
                errorCount++;
                keepUnlessGone(error);
            }
        }

        // Publish categories entity
        const categoriesArray = Array.from(categories).sort();
        const categoriesData = {
            list: categoriesArray,
            discoveryTopic: getCategoriesDiscoveryTopic(mqttConfig.topicPrefix, mqttConfig.discoveryPrefix),
            stateTopic: getCategoriesStateTopic(mqttConfig.topicPrefix),
        };

        if (categories.size > 0 && publisher)
            await publisher.publishCategories(categoriesArray);

        // Cleanup removed entities: one stays listed until its clear goes through, as the broker still holds it
        const toRemove = findItemsToRemove(previouslyPublished, currentPublished);
        if (toRemove.length > 0) {
            if (isDryRun) {
                console.log(`[DRY-RUN] Would remove ${toRemove.length} unused entities`);
            } else if (publisher) {
                console.log(`[MQTT] Removing ${toRemove.length} unused entities...`);

                for (const id of await publisher.removeEntities(toRemove))
                    cleared.add(id);
            }
        }

        saveList?.();

        // Write the dry-run manifest or the summary
        if (isDryRun) {
            // Write dry-run manifest
            writeDryRunManifest(
                mqttConfig,
                dryRunEntities,
                categoriesData,
                { removedIds: toRemove, removedCount: toRemove.length },
                {
                    totalProcessed: savedItems.length,
                    successCount,
                    errorCount,
                    categoriesCount: categories.size,
                    byType: countByType,
                }
            );
        } else {
            console.log(`[MQTT] Successfully published ${successCount} items (${countByType.playlists} playlists, ${countByType.albums} albums, ${countByType['plex-media']} plex media)`);
        }

        // Mark sync as complete
        completeSyncType('mqtt');
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[MQTT] ERROR: ${message}`);
        // Lists what this run may have put on the broker; a failed save here leaves the run's own error shown
        try {
            saveList?.();
        } catch (saveError) {
            console.error(`[MQTT] ERROR: ${saveError instanceof Error ? saveError.message : 'Unknown error'}`);
        }

        errorSyncType('mqtt', message);
        throw error;
    } finally {
        if (!isDryRun && client)
            await client.disconnect();
    }
}

/**
 * Helper function to resolve Plex ID from SavedItem
 */
function resolvePlexId(item: SavedItem, playlists: PlaylistData, trackLinks: TrackLink[]) {

    switch (item.type) {
        case 'spotify-playlist':
            return findPlaylistPlexId(item.id, playlists);
        case 'spotify-album':
            const plexPath = findAlbumPlexId(item.id, trackLinks);
            if (plexPath) {
                const match = /\/library\/metadata\/(\d+)/.exec(plexPath);

                return match?.[1] ?? null;
            }

            return null;
        case 'plex-media':
            return extractPlexMediaId(item.uri);
        default:
            return null;
    }
}

/**
 * Runner function
 */
function run() {
    console.log('Start MQTT sync');
    syncMQTT()
        .then(() => {
            console.log('MQTT sync complete');
        })
        .catch((e: unknown) => {
            console.error('MQTT sync failed:', e);
        });
}

// Only run if this file is executed directly, not when imported
// eslint-disable-next-line unicorn/prefer-module
if (require.main === module) {
    run();
}
