import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const published: { topic: string; message: string; retain?: boolean }[] = [];
const record = async (topic: string, message: string, options?: { retain?: boolean }) => { published.push({ topic, message, retain: options?.retain }) };
const publish = vi.fn(record);
vi.mock('../services/mqtt/createMQTTClient', () => ({
    createMQTTClient: () => ({ connect: vi.fn(), disconnect: vi.fn(), publish, isConnected: () => true })
}));

const getById = vi.fn();
vi.mock('@spotify-to-plex/plex-music-search/functions/getById', () => ({ getById }));

const { PlexItemMissingError } = await import('@spotify-to-plex/plex-music-search/utils/PlexItemMissingError');
const { createEntityId } = await import('../services/mqtt/createEntityId');
const { createDiscoveryTopic } = await import('../services/mqtt/createDiscoveryTopic');
const { createStateTopic } = await import('../services/mqtt/createStateTopic');
const { getCategoriesDiscoveryTopic } = await import('../services/mqtt/getCategoriesDiscoveryTopic');
const { syncMQTT } = await import('../jobs/mqtt');

let dir: string;

const write = (name: string, data: unknown) => writeFileSync(join(dir, name), JSON.stringify(data));
const saved = (id: string, plexId: number) => ({ type: 'plex-media', uri: `/library/metadata/${plexId}`, id, title: id, label: 'Mood' });
const previous = (id: string) => ({ id, entity_id: `sensor.spotify_to_plex_item_${id}`, category: 'Mood' });

const PREFIX = 'spotify_to_plex';
const IDS = ['kept', 'flaky', 'deleted', 'unsaved', 'fresh'];
// A clear left unretained does not remove what the broker holds
const cleared = (topic: string, retained = false) => published.some(item => item.topic === topic && item.message === '' && (!retained || item.retain === true));
const configTopic = (id: string) => createDiscoveryTopic(createEntityId(id, PREFIX), 'homeassistant');
const configCleared = (id: string, retained?: boolean) => cleared(configTopic(id), retained);
const sent = () => published.filter(item => item.message !== '' && item.retain === true).map(item => item.topic);
const stateCleared = (id: string, retained?: boolean) => cleared(createStateTopic(id, PREFIX), retained);

// Removing an entity clears its retained discovery config and its state; any clear alone counts as removing it
const removed = () => {
    const ids = IDS.filter(id => configCleared(id) || stateCleared(id));
    expect(ids.filter(id => !configCleared(id, true) || !stateCleared(id, true)), 'not fully removed').toEqual([]);

    return ids;
};
const kept = () => (JSON.parse(readFileSync(join(dir, 'mqtt_published_items.json'), 'utf8')) as { id: string }[]).map(item => item.id);

// The cleanup removes what was published last time and is gone now: an item that only
// failed this run is still there, and deleting it empties a Home Assistant dashboard
describe('syncMQTT cleanup', () => {
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'mqtt-cleanup-'));
        vi.stubEnv('STORAGE_DIR', dir);
        vi.stubEnv('MQTT_BROKER_URL', 'mqtt://broker.test');
        // A dry run publishes nothing, so there would be no removals to read
        vi.stubEnv('MQTT_DRY_RUN', 'false');
        vi.stubEnv('MQTT_TOPIC_PREFIX', PREFIX);
        published.length = 0;
        // A test that makes publishing fail must not carry that into the next one
        publish.mockReset();
        publish.mockImplementation(record);
        getById.mockReset();
        getById.mockResolvedValue({ image: '/thumb' });

        write('plex.json', { id: 'server', uri: 'http://plex.test:32400', token: 'token' });
        write('spotify_saved_items.json', [saved('kept', 1), saved('flaky', 2), saved('deleted', 3)]);
        write('mqtt_published_items.json', [previous('kept'), previous('flaky'), previous('deleted'), previous('unsaved')]);

        vi.spyOn(console, 'log').mockImplementation(() => { /* expected */ });
        vi.spyOn(console, 'warn').mockImplementation(() => { /* expected */ });
        vi.spyOn(console, 'error').mockImplementation(() => { /* expected */ });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        rmSync(dir, { recursive: true, force: true });
    });

    it('keeps an entity when Plex fails to answer, and removes one Plex no longer has', async () => {
        getById.mockImplementation(async (_config: unknown, key: string) => {
            if (key.endsWith('/2'))
                throw new Error('read ECONNRESET');

            if (key.endsWith('/3'))
                throw new PlexItemMissingError(key);

            return { image: '/thumb' };
        });

        await syncMQTT();

        expect(removed()).toEqual(['deleted', 'unsaved']);
        expect(kept()).toEqual(['kept', 'flaky']);
    });

    it('keeps an entity whose publish failed, as the broker still holds the last one', async () => {
        publish.mockImplementation(async (topic: string, message: string, options?: { retain?: boolean }) => {
            if (topic.includes('flaky') && message !== '')
                throw new Error('publish timed out');

            await record(topic, message, options);
        });

        await syncMQTT();

        expect(removed()).toEqual(['unsaved']);
        expect(kept()).toEqual(['kept', 'flaky', 'deleted']);
    });

    // Its config is retained on the broker though its state publish failed: left untracked, no run would clear it
    it('tracks a new entity whose publish failed partway, so a later run can remove it', async () => {
        write('spotify_saved_items.json', [saved('kept', 1), saved('fresh', 4)]);
        write('mqtt_published_items.json', [previous('kept')]);
        publish.mockImplementation(async (topic: string, message: string, options?: { retain?: boolean }) => {
            await record(topic, message, options);
            if (topic === createStateTopic('fresh', PREFIX) && message !== '')
                throw new Error('publish timed out');
        });

        await syncMQTT();

        // Its config went out, then its state publish threw
        expect(sent()).toEqual(expect.arrayContaining([configTopic('fresh'), createStateTopic('fresh', PREFIX)]));
        expect(kept()).toEqual(['kept', 'fresh']);

        // Unsaved before the next run: its retained config is cleared
        write('spotify_saved_items.json', [saved('kept', 1)]);
        published.length = 0;
        publish.mockImplementation(record);

        await syncMQTT();

        expect(removed()).toEqual(['fresh']);
        expect(kept()).toEqual(['kept']);
    });

    it('saves the list when a publish after the items fails, and stops the run', async () => {
        write('spotify_saved_items.json', [saved('kept', 1), saved('fresh', 4)]);
        write('mqtt_published_items.json', [previous('kept'), previous('unsaved')]);
        // The broker is gone from fresh's state publish on, the categories publish included
        let down = false;
        publish.mockImplementation(async (topic: string, message: string, options?: { retain?: boolean }) => {
            if (topic === createStateTopic('fresh', PREFIX))
                down = true;

            if (down)
                throw new Error('Connection closed');

            await record(topic, message, options);
        });

        await expect(syncMQTT()).rejects.toThrow('Failed to publish categories');

        expect(removed()).toEqual([]);
        expect(kept()).toEqual(['kept', 'fresh', 'unsaved']);
    });

    it('keeps listing an entity whose clear failed, so the next run clears it', async () => {
        write('spotify_saved_items.json', [saved('kept', 1)]);
        write('mqtt_published_items.json', [previous('kept'), previous('unsaved')]);
        publish.mockImplementation(async (topic: string, message: string, options?: { retain?: boolean }) => {
            if (topic === createStateTopic('unsaved', PREFIX) && message === '')
                throw new Error('publish timed out');

            await record(topic, message, options);
        });

        await syncMQTT();

        expect(kept()).toEqual(['kept', 'unsaved']);

        published.length = 0;
        publish.mockImplementation(record);

        await syncMQTT();

        expect(removed()).toEqual(['unsaved']);
        expect(kept()).toEqual(['kept']);
    });

    it('stops the run and leaves the list alone when the list cannot be read', async () => {
        writeFileSync(join(dir, 'mqtt_published_items.json'), '{ half written');

        await expect(syncMQTT()).rejects.toThrow('Failed to load mqtt_published_items.json');

        expect(published).toEqual([]);
        expect(readFileSync(join(dir, 'mqtt_published_items.json'), 'utf8')).toBe('{ half written');
    });

    it('fails the run when the list cannot be saved', async () => {
        // A directory where the atomic write puts its temp file
        mkdirSync(join(dir, `mqtt_published_items.json.${process.pid}.tmp`));

        await expect(syncMQTT()).rejects.toThrow('Failed to save published items');

        expect(kept()).toEqual(['kept', 'flaky', 'deleted', 'unsaved']);
    });

    it('reports the publish that failed, not the save that failed after it', async () => {
        mkdirSync(join(dir, `mqtt_published_items.json.${process.pid}.tmp`));
        publish.mockImplementation(async (topic: string, message: string, options?: { retain?: boolean }) => {
            if (topic === getCategoriesDiscoveryTopic(PREFIX, 'homeassistant'))
                throw new Error('Connection closed');

            await record(topic, message, options);
        });

        await expect(syncMQTT()).rejects.toThrow('Failed to publish categories');

        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to save published items'));
    });

    it.each(['playlists.json', 'track_links.json'])('removes nothing when %s cannot be read', async file => {
        writeFileSync(join(dir, file), '{ half written');

        await expect(syncMQTT()).rejects.toThrow(`Failed to load ${file}`);

        expect(removed()).toEqual([]);
        expect(kept()).toEqual(['kept', 'flaky', 'deleted', 'unsaved']);
    });

    it('does not keep an item that was never published', async () => {
        write('mqtt_published_items.json', [previous('kept')]);
        getById.mockImplementation(async (_config: unknown, key: string) => {
            if (key.endsWith('/1'))
                return { image: '/thumb' };

            throw new Error('read ECONNRESET');
        });

        await syncMQTT();

        expect(removed()).toEqual([]);
        expect(kept()).toEqual(['kept']);
    });
});
