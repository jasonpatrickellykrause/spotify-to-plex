/**
 * MQTT Client
 * MQTT connection management with Promise wrappers for mqtt.js callbacks
 */

import mqtt, { MqttClient } from 'mqtt';
import { MQTTConfig, MQTTPublishOptions } from './types';

const DEFAULT_PUBLISH_OPTIONS: MQTTPublishOptions = { qos: 1, retain: true };

/**
 * Create MQTT client with connection management
 * Returns an object with connect, publish, disconnect, and isConnected methods
 */
export function createMQTTClient(config: MQTTConfig) {
    let client: MqttClient | null = null;

    /**
   * Connect to MQTT broker
   * Returns a Promise that resolves when connected
   */
    const connect = async () => {
        return new Promise<void>((resolve, reject) => {
            const options: mqtt.IClientOptions = {
                username: config.username,
                password: config.password,
                clean: true,
                reconnectPeriod: 0, // Disable auto-reconnect for one-time jobs
            };

            const connecting = mqtt.connect(config.brokerUrl, options);
            client = connecting;
            let settled = false;

            const fail = (error: Error) => {
                if (settled)
                    return;

                settled = true;
                // Nothing to disconnect from later: end it here, so disconnect() returns at once
                client = null;
                connecting.end(true);
                reject(error);
            };

            connecting.on('connect', () => {
                settled = true;
                console.log('[MQTT] Connected to broker');
                resolve();
            });

            connecting.on('error', (error) => {
                console.error('[MQTT] Connection error:', error.message);
                fail(error);
            });

            // A broker that drops the socket before answering only closes it (a silent one gets a
            // "connack timeout" error); with reconnecting off, nothing else would settle this promise
            connecting.on('close', () => {
                if (!settled) {
                    fail(new Error('Connection to the MQTT broker closed before it was established'));

                    return;
                }

                // mqtt.js keeps unacknowledged QoS 1 publishes for a reconnect that is off here: a forced
                // end fails them, where they would otherwise wait for ever and hold the job's lock
                client = null;
                connecting.end(true);
            });
        });
    };

    /**
   * Publish a message to MQTT broker
   * Returns a Promise that resolves when message is published
   */
    const publish = async (topic: string, message: string, options: MQTTPublishOptions = DEFAULT_PUBLISH_OPTIONS) => {
        if (!client) {
            throw new Error('MQTT client not connected');
        }

        return new Promise<void>((resolve, reject) => {
            client!.publish(topic, message, options, (error) => {
                if (error) {
                    console.error(`[MQTT] Failed to publish to ${topic}:`, error.message);
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    };

    /**
   * Disconnect from MQTT broker
   * Returns a Promise that resolves when disconnected
   */
    const disconnect = async () => {
        if (!client) 
            return;

        return new Promise<void>((resolve) => {
            client!.end(false, {}, () => {
                console.log('[MQTT] Disconnected');
                client = null;
                resolve();
            });
        });
    };

    /**
   * Check if client is connected
   */
    const isConnected = () => {
        return client?.connected ?? false;
    };

    return {
        connect,
        publish,
        disconnect,
        isConnected,
    };
}
