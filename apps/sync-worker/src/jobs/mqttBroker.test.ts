import { createServer, Server, Socket } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real mqtt.js client against a local broker: only Plex is stubbed
const getById = vi.fn();
vi.mock('@spotify-to-plex/plex-music-search/functions/getById', () => ({ getById }));

const { createStateTopic } = await import('../services/mqtt/createStateTopic');
const { syncMQTT } = await import('./mqtt');

const PREFIX = 'spotify_to_plex';
const CONNECT = 1;
const PUBLISH = 3;
const PINGREQ = 12;
const DISCONNECT = 14;

let dir: string;
let server: Server;
const sockets: Socket[] = [];
const seen: string[] = [];
const write = (name: string, data: unknown) => writeFileSync(join(dir, name), JSON.stringify(data));
const saved = (id: string, plexId: number) => ({ type: 'plex-media', uri: `/library/metadata/${plexId}`, id, title: id, label: 'Mood' });
const previous = (id: string) => ({ id, entity_id: `sensor.spotify_to_plex_item_${id}`, category: 'Mood' });
const kept = () => (JSON.parse(readFileSync(join(dir, 'mqtt_published_items.json'), 'utf8')) as { id: string }[]).map(item => item.id);

// One whole MQTT packet from the front of the buffer, or undefined until it has all arrived
function readPacket(buffer: Buffer) {
    let length = 0;
    let offset = 1;

    for (let multiplier = 1; ; multiplier *= 128) {
        const byte = buffer[offset++];
        if (byte === undefined)
            return;

        length += (byte % 128) * multiplier;
        if (byte < 128)
            break;
    }

    if (buffer.length < offset + length)
        return;

    return { type: Math.floor(buffer[0]! / 16), qos: Math.floor(buffer[0]! / 2) % 4, body: buffer.subarray(offset, offset + length), size: offset + length };
}

// MQTT 3.1.1, just enough for the job: accepts, acknowledges QoS 1, and drops the connection on one topic
function startBroker(dropOn: string) {
    server = createServer(socket => {
        sockets.push(socket);
        let buffer = Buffer.alloc(0);
        socket.on('error', () => { /* the drop below */ });
        socket.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk]);

            for (let packet = readPacket(buffer); packet; packet = readPacket(buffer)) {
                buffer = buffer.subarray(packet.size);
                if (packet.type === CONNECT)
                    socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));

                if (packet.type === PINGREQ)
                    socket.write(Buffer.from([0xD0, 0x00]));

                if (packet.type === DISCONNECT)
                    socket.end();

                if (packet.type !== PUBLISH)
                    continue;

                const topicLength = packet.body.readUInt16BE(0);
                const topic = packet.body.subarray(2, 2 + topicLength).toString();
                seen.push(topic);
                if (topic === dropOn) {
                    socket.destroy();

                    return;
                }

                if (packet.qos > 0)
                    socket.write(Buffer.concat([Buffer.from([0x40, 0x02]), packet.body.subarray(2 + topicLength, 4 + topicLength)]));
            }
        });
    });

    return new Promise<void>(resolve => {
        server.listen(0, '127.0.0.1', () => {
            vi.stubEnv('MQTT_BROKER_URL', `mqtt://127.0.0.1:${(server.address() as { port: number }).port}`);
            resolve();
        });
    });
}

describe('syncMQTT with a real MQTT client', () => {
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'mqtt-broker-'));
        seen.length = 0;
        vi.stubEnv('STORAGE_DIR', dir);
        vi.stubEnv('MQTT_DRY_RUN', 'false');
        vi.stubEnv('MQTT_TOPIC_PREFIX', PREFIX);
        getById.mockReset();
        getById.mockResolvedValue({ image: '/thumb' });
        write('plex.json', { id: 'server', uri: 'http://plex.test:32400', token: 'token' });
        write('spotify_saved_items.json', [saved('kept', 1), saved('fresh', 4)]);
        write('mqtt_published_items.json', [previous('kept')]);
        vi.spyOn(console, 'log').mockImplementation(() => { /* expected */ });
        vi.spyOn(console, 'warn').mockImplementation(() => { /* expected */ });
        vi.spyOn(console, 'error').mockImplementation(() => { /* expected */ });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();

        for (const socket of sockets)
            socket.destroy();

        sockets.length = 0;
        await new Promise<void>(resolve => { server.close(() => { resolve() }) });
        rmSync(dir, { recursive: true, force: true });
    });

    it('publishes and lists every entity', async () => {
        await startBroker('never/published');

        await syncMQTT();

        expect(seen).toContain(createStateTopic('fresh', PREFIX));
        expect(kept()).toEqual(['kept', 'fresh']);
    });

    // mqtt.js would hold a publish the broker never acknowledged for a reconnect that never comes
    it('stops the run when the broker drops mid-run, with the entity it half published listed', async () => {
        write('spotify_saved_items.json', [saved('kept', 1), saved('fresh', 4), saved('later', 5)]);
        write('mqtt_published_items.json', [previous('kept'), previous('later')]);
        await startBroker(createStateTopic('fresh', PREFIX));

        await expect(syncMQTT()).rejects.toThrow('Lost the connection to the MQTT broker');

        expect(seen).toContain('homeassistant/sensor/spotify_to_plex_item_fresh/config');
        expect(getById).not.toHaveBeenCalledWith(expect.anything(), '/library/metadata/5');
        expect(kept()).toEqual(['kept', 'fresh', 'later']);
    });
});
