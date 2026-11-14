import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { manifest } = vi.hoisted(() => ({ manifest: vi.fn() }));
vi.mock('@spotify-to-plex/plex-config/functions/getSettings', () => ({ getSettings: async () => ({ id: 'machine', uri: 'http://plex.test:32400', token: 'owner-server' }) }));
vi.mock('@spotify-to-plex/plex-music-search/functions/getById', () => ({ getById: async () => ({ image: '/thumb' }) }));
vi.mock('../services/mqtt/writeDryRunManifest', () => ({ writeDryRunManifest: manifest }));

const { syncMQTT } = await import('./mqtt');

let dir: string;
const write = (name: string, data: unknown) => { writeFileSync(join(dir, name), JSON.stringify(data)) };

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mqtt-job-'));
    process.env.STORAGE_DIR = dir;
    process.env.MQTT_DRY_RUN = 'true';
    process.env.MQTT_BROKER_URL = 'mqtt://broker.test';
    process.env.MQTT_TOPIC_PREFIX = 'test_prefix';
    manifest.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => { /* expected */ });
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MQTT_DRY_RUN;
    delete process.env.MQTT_BROKER_URL;
    delete process.env.MQTT_TOPIC_PREFIX;
});

describe('syncMQTT', () => {
    // Home Assistant plays as the Plex owner, who can't see a Home user's playlist
    it("publishes neither a Plex Home user's playlist nor its label", async () => {
        write('spotify.json', [
            { user: { id: 'dean', name: 'Dean' } },
            { user: { id: 'faye', name: 'Faye', plex_home_user: { uuid: 'uuid-faye', title: 'Faye' } } }
        ]);
        write('spotify_saved_items.json', [
            { type: 'spotify-playlist', id: 'p-dean', title: 'Mine', uri: 'spotify:playlist:p-dean', label: 'Dean', user: 'dean' },
            { type: 'spotify-playlist', id: 'p-faye', title: 'Hers', uri: 'spotify:playlist:p-faye', label: 'Faye', user: 'faye' }
        ]);
        write('playlists.json', { data: [{ type: 'spotify-playlist', id: 'p-dean', plex: '11' }, { type: 'spotify-playlist', id: 'p-faye', plex: '22' }] });

        await syncMQTT();

        expect(manifest).toHaveBeenCalledTimes(1);
        const [, entities, categories] = manifest.mock.calls[0] ?? [];
        expect(entities.map((item: { entity: { title?: string, name?: string } }) => item.entity.title ?? item.entity.name)).toEqual(['Mine']);
        expect(categories.list).toEqual(['Dean']);
    });

    it("lists each entity's topics and saved record in the dry-run manifest", async () => {
        write('spotify_saved_items.json', [{ type: 'plex-media', id: 'Mix-1', title: 'Mix', uri: '/library/metadata/7', label: 'Mood' }]);

        await syncMQTT();

        const [, entities] = manifest.mock.calls[0] ?? [];
        expect(entities.map(({ discoveryTopic, stateTopic, published }: Record<string, unknown>) => ({ discoveryTopic, stateTopic, published }))).toEqual([{
            discoveryTopic: 'homeassistant/sensor/test_prefix_item_mix1/config',
            stateTopic: 'test_prefix/items/Mix-1/state',
            published: { id: 'Mix-1', entity_id: 'sensor.test_prefix_item_mix1', category: 'Mood' },
        }]);
    });
});
