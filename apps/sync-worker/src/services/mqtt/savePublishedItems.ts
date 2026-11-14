import { join } from 'node:path';
import { getStorageDir } from '@spotify-to-plex/shared-utils/utils/getStorageDir';
import { writeJsonFileAtomic } from '@spotify-to-plex/shared-utils/utils/writeJsonFileAtomic';
import { PublishedItem } from './types';

/**
 * Save currently published items
 */
export function savePublishedItems(items: PublishedItem[]) {
    const storageDir = getStorageDir();
    const publishedItemsPath = join(storageDir, 'mqtt_published_items.json');

    try {
        writeJsonFileAtomic(publishedItemsPath, items, 2);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        // Not "saved": the next run could not clear what this one published
        throw new Error(`Failed to save published items: ${message}`);
    }
}
