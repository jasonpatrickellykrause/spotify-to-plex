/**
 * MQTT Publisher
 * Publish entities to MQTT with Home Assistant Discovery protocol
 */

import { createEntityId } from './createEntityId';
import { createDiscoveryTopic } from './createDiscoveryTopic';
import { createStateTopic } from './createStateTopic';
import { createDiscoveryConfig } from './createDiscoveryConfig';
import { createStatePayload } from './createStatePayload';
import { buildCategoriesEntity } from './buildCategoriesEntity';
import { createCategoriesDiscoveryConfig } from './createCategoriesDiscoveryConfig';
import { getCategoriesDiscoveryTopic } from './getCategoriesDiscoveryTopic';
import { getCategoriesStateTopic } from './getCategoriesStateTopic';
import { MQTTEntity } from './types';

type MQTTClient = {
    publish: (topic: string, message: string, options?: { qos: 0 | 1 | 2; retain: boolean }) => Promise<void>;
};

/**
 * Create MQTT publisher with client and configuration
 * Returns an object with methods to publish and remove entities
 */
export function createMQTTPublisher(client: MQTTClient, topicPrefix: string, discoveryPrefix: string) {
    /**
   * Publish a single entity to MQTT
   * Publishes both discovery config and state topics with retained messages
   */
    const publishEntity = async (entity: MQTTEntity) => {
        const entityId = createEntityId(entity.id, topicPrefix);
        const discoveryTopic = createDiscoveryTopic(entityId, discoveryPrefix);
        const stateTopic = createStateTopic(entity.id, topicPrefix);

        // Create discovery config
        const discoveryConfig = createDiscoveryConfig(entity, topicPrefix);
        const discoveryPayload = JSON.stringify(discoveryConfig, null, 2);

        // Create state payload
        const statePayload = createStatePayload(entity);

        try {
            // Publish discovery config (retained, QoS 1)
            await client.publish(discoveryTopic, discoveryPayload, {
                qos: 1,
                retain: true,
            });

            // Publish state (retained, QoS 1)
            await client.publish(stateTopic, statePayload, {
                qos: 1,
                retain: true,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to publish entity ${entity.id}: ${message}`);
        }
    };

    /**
   * Publish categories entity
   */
    const publishCategories = async (categories: string[]) => {
        const categoriesEntity = buildCategoriesEntity(categories);
        const discoveryConfig = createCategoriesDiscoveryConfig(topicPrefix);

        const discoveryTopic = getCategoriesDiscoveryTopic(topicPrefix, discoveryPrefix);
        const stateTopic = getCategoriesStateTopic(topicPrefix);

        try {
            // Publish discovery config
            await client.publish(discoveryTopic, JSON.stringify(discoveryConfig, null, 2), {
                qos: 1,
                retain: true,
            });

            // Publish state (simple string, not JSON)
            await client.publish(stateTopic, categoriesEntity.state, {
                qos: 1,
                retain: true,
            });

            console.log(`[MQTT] Published categories: ${categories.length} categories`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to publish categories: ${message}`);
        }
    };

    /**
   * Publish empty retained message to remove an entity
   */
    const removeEntity = async (itemId: string) => {
        const entityId = createEntityId(itemId, topicPrefix);
        const discoveryTopic = createDiscoveryTopic(entityId, discoveryPrefix);
        const stateTopic = createStateTopic(itemId, topicPrefix);

        try {
            // Publish empty retained messages to remove entity
            await client.publish(discoveryTopic, '', {
                qos: 1,
                retain: true,
            });

            await client.publish(stateTopic, '', {
                qos: 1,
                retain: true,
            });

            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            console.error(`[MQTT] Failed to remove entity ${itemId}: ${message}`);

            return false;
        }
    };

    /**
   * Remove multiple entities; returns the ids whose clear failed, which the broker may still hold
   */
    const removeEntities = async (itemIds: string[]) => {
        const failed: string[] = [];

        for (const itemId of itemIds) {
            if (!await removeEntity(itemId))
                failed.push(itemId);
        }

        return failed;
    };

    return {
        publishEntity,
        publishCategories,
        removeEntity,
        removeEntities,
    };
}
