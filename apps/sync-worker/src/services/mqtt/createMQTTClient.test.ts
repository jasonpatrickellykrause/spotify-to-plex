import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stands in for mqtt.js's client, which is an EventEmitter: the tests emit its events
// eslint-disable-next-line unicorn/prefer-event-target
class FakeClient extends EventEmitter {
    public end = vi.fn((_force?: boolean, _options?: object, done?: () => void) => {
        done?.();

        return this;
    });
}

let fake: FakeClient;
vi.mock('mqtt', () => ({ default: { connect: () => fake } }));

const { createMQTTClient } = await import('./createMQTTClient');
const config = { brokerUrl: 'mqtt://broker.test', topicPrefix: 'spotify_to_plex', discoveryPrefix: 'homeassistant' };

describe('createMQTTClient connect', () => {
    beforeEach(() => {
        fake = new FakeClient();
        vi.spyOn(console, 'log').mockImplementation(() => { /* expected */ });
        vi.spyOn(console, 'error').mockImplementation(() => { /* expected */ });
    });

    afterEach(() => { vi.restoreAllMocks() });

    it('resolves once the broker accepts', async () => {
        const client = createMQTTClient(config);
        const connecting = client.connect();
        fake.emit('connect');

        await expect(connecting).resolves.toBeUndefined();
    });

    it('rejects on an error and ends the client, so disconnect has nothing to wait on', async () => {
        const client = createMQTTClient(config);
        const connecting = client.connect();
        fake.emit('error', new Error('connack timeout'));

        await expect(connecting).rejects.toThrow('connack timeout');
        expect(fake.end).toHaveBeenCalledWith(true);

        await client.disconnect();
        expect(fake.end).toHaveBeenCalledTimes(1);
    });

    it('rejects when the connection closes before the broker answers', async () => {
        const client = createMQTTClient(config);
        const connecting = client.connect();
        fake.emit('close');

        await expect(connecting).rejects.toThrow('closed before it was established');
    });

    it('ends the client when the connection closes after it connected, so later publishes fail', async () => {
        const client = createMQTTClient(config);
        const connecting = client.connect();
        fake.emit('connect');
        await connecting;

        fake.emit('close');

        expect(fake.end).toHaveBeenCalledWith(true);
        await expect(client.publish('topic', 'message')).rejects.toThrow('MQTT client not connected');
    });
});
