import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { LidarrLookupResult } from '@spotify-to-plex/shared-types/musicbrainz/LidarrLookupResult';
import { addOrMonitorAlbum } from './addOrMonitorAlbum';
import { getReleasesWithoutStatus } from '../musicbrainz/getReleasesWithoutStatus';

vi.mock('axios', () => ({
    default: { get: vi.fn(), put: vi.fn(), post: vi.fn(), isAxiosError: (error: { isAxiosError?: boolean }) => error?.isAxiosError === true }
}));

vi.mock('../musicbrainz/getReleasesWithoutStatus', () => ({ getReleasesWithoutStatus: vi.fn(async () => []) }));

const statusMock = getReleasesWithoutStatus as unknown as Mock;
const getMock = axios.get as unknown as Mock;
const postMock = axios.post as unknown as Mock;
const putMock = axios.put as unknown as Mock;

const lookup = { id: 0, foreignAlbumId: 'rg-1', title: 'Hooked', releases: [{ foreignReleaseId: 'rel-spotify' }], artist: { foreignArtistId: 'ar-1', artistName: 'NOTION' } } as LidarrLookupResult;
const alreadyAdded = [{ errorCode: 'AlbumExistsValidator', errorMessage: 'This album has already been added.' }];
// Most cases here are about the pin, so pinning is on; the default (off) has its own cases below
const settings = { url: 'http://lidarr:8686/', root_folder_path: '/music', quality_profile_id: 4, metadata_profile_id: 1, pin_spotify_release: true };
const unpinned = { ...settings, pin_spotify_release: undefined };
const releases = [{ id: 1, foreignReleaseId: 'rel-extended', monitored: true }, { id: 2, foreignReleaseId: 'rel-spotify', monitored: false }];

const adds = () => postMock.mock.calls.filter(([url]) => String(url).endsWith('/api/v1/album'));
const searches = () => postMock.mock.calls.filter(([, body]) => body?.name === 'AlbumSearch');

type FakeAlbum = { id: number; foreignAlbumId: string; title: string; monitored: boolean; artistId: number; anyReleaseOk: boolean; releases: { id: number; foreignReleaseId: string; monitored: boolean }[]; statistics?: { trackFileCount: number; totalTrackCount: number } };

/**
 * A Lidarr whose add saves the album without releases, which the refresh it queues loads 6 s later.
 * Each AlbumSearch records whether Spotify's release was pinned at that moment.
 */
function fakeLidarr(options: { firstAddTimesOutAfterSaving?: boolean } = {}) {
    const state: { album: FakeAlbum | null; searches: { pinned: boolean }[]; addAttempts: number } = { album: null, searches: [], addAttempts: 0 };
    const pinned = () => state.album?.anyReleaseOk === false && state.album.releases.find(r => r.foreignReleaseId === 'rel-spotify')?.monitored === true;

    getMock.mockImplementation(async () => ({ data: state.album ? [structuredClone(state.album)] : [] }));
    putMock.mockImplementation(async (_url: string, body: FakeAlbum) => {
        state.album = { ...state.album!, ...structuredClone(body) };

        return { data: state.album };
    });
    postMock.mockImplementation(async (_url: string, body: any) => {
        if (body?.name === 'AlbumSearch') {
            state.searches.push({ pinned: pinned() });

            return { data: {} };
        }

        state.addAttempts++;
        if (state.album)
            throw Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: alreadyAdded } });

        state.album = { id: 7, foreignAlbumId: 'rg-1', title: 'Hooked', monitored: true, artistId: 1, anyReleaseOk: true, releases: [] };
        setTimeout(() => {
            state.album!.releases = releases.map(r => ({ ...r }));
            state.album!.statistics = { trackFileCount: 0, totalTrackCount: 10 };
        }, 6000);

        if (options.firstAddTimesOutAfterSaving && state.addAttempts === 1)
            throw Object.assign(new Error('timeout of 30000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' });

        return { data: state.album };
    });

    return state;
}

function rejectAdd(status: number, data: unknown) {
    postMock.mockImplementation(async (url: string) => {
        if (url.endsWith('/api/v1/album'))
            throw Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

        return { data: {} };
    });
}

describe('addOrMonitorAlbum', () => {
    beforeEach(() => {
        getMock.mockReset();
        postMock.mockReset();
        putMock.mockReset();
        postMock.mockResolvedValue({ data: { id: 7 } });
        getMock.mockResolvedValue({ data: [{ id: 7, foreignAlbumId: 'rg-1', title: 'Hooked', monitored: true, artistId: 1, anyReleaseOk: true, releases, statistics: { trackFileCount: 0, totalTrackCount: 1 } }] });
    });

    it("adds without Lidarr's own search, pins Spotify's release, then searches once", async () => {
        const outcome = await addOrMonitorAlbum(lookup, 'rel-spotify', settings, 'key');

        expect(adds()).toHaveLength(1);
        expect(adds()[0]?.[0]).toBe('http://lidarr:8686/api/v1/album');
        expect(adds()[0]?.[1]).toMatchObject({ foreignAlbumId: 'rg-1', qualityProfileId: 4, rootFolderPath: '/music', addOptions: { searchForNewAlbum: false }, artist: { monitorNewItems: 'none' } });
        // Monitor "none" makes Lidarr unmonitor the artist; the list keeps only the requested album monitored
        expect(adds()[0]?.[1]).toMatchObject({ artist: { monitored: true, addOptions: { monitor: 'existing', albumsToMonitor: ['rg-1'] } } });
        expect(putMock.mock.calls[0]?.[1]).toMatchObject({ anyReleaseOk: false, releases: [{ id: 1, monitored: false }, { id: 2, monitored: true }] });
        expect(searches()).toHaveLength(1);
        expect(outcome).toMatchObject({ result: 'added', ok: true });
    });

    it('takes the album Lidarr already has when it answers "already added", and pins and searches that', async () => {
        rejectAdd(400, alreadyAdded);

        const outcome = await addOrMonitorAlbum(lookup, 'rel-spotify', settings, 'key');

        expect(putMock.mock.calls[0]?.[1]).toMatchObject({ anyReleaseOk: false });
        expect(searches()).toHaveLength(1);
        expect(outcome).toMatchObject({ result: 'existing', ok: true });
    });

    it('sends no add for an album the lookup found in Lidarr, and pins and searches that', async () => {
        const outcome = await addOrMonitorAlbum({ ...lookup, id: 7 }, 'rel-spotify', settings, 'key');

        expect(adds()).toHaveLength(0);
        expect(putMock.mock.calls[0]?.[1]).toMatchObject({ anyReleaseOk: false });
        expect(searches()).toHaveLength(1);
        expect(outcome).toMatchObject({ result: 'existing', ok: true });
    });

    // Lidarr stores the sent list when its metadata has no cover; a missing one fails its NOT NULL Images column
    it('sends an empty image list with the add', async () => {
        await addOrMonitorAlbum(lookup, 'rel-spotify', settings, 'key');

        expect(adds()[0]?.[1]).toMatchObject({ images: [] });
    });

    it("sends no add for an album Lidarr's metadata has no releases for", async () => {
        const outcome = await addOrMonitorAlbum({ ...lookup, releases: [] }, 'rel-spotify', settings, 'key');

        expect(adds()).toHaveLength(0);
        expect(searches()).toHaveLength(0);
        expect(outcome).toEqual({ result: 'not_found', ok: false, message: "Lidarr's metadata has no releases for this album yet" });
    });

    // Lidarr's metadata server leaves such releases out, so waiting for it would never help
    it('says so, and names the releases, when none of the MusicBrainz releases has a status', async () => {
        statusMock.mockResolvedValueOnce(['rel-a', 'rel-b']);

        const outcome = await addOrMonitorAlbum({ ...lookup, releases: [] }, 'rel-spotify', settings, 'key');

        expect(statusMock).toHaveBeenCalledWith('rg-1');
        expect(adds()).toHaveLength(0);
        expect(outcome).toMatchObject({ result: 'not_found', ok: false, releasesWithoutStatus: ['rel-a', 'rel-b'] });
        expect(outcome.message).toMatch(/no status/);
    });

    it('keeps the waiting message when MusicBrainz cannot be asked', async () => {
        statusMock.mockResolvedValueOnce(undefined);

        const outcome = await addOrMonitorAlbum({ ...lookup, releases: [] }, 'rel-spotify', settings, 'key');

        expect(outcome).toEqual({ result: 'not_found', ok: false, message: "Lidarr's metadata has no releases for this album yet" });
    });

    // Lidarr answers any failed database constraint with 409, not only a second add of the same album
    it("reports a 409 Lidarr's reason when the album is still not in Lidarr, and searches nothing", async () => {
        rejectAdd(409, { message: 'constraint failed\nNOT NULL constraint failed: Albums.Images' });
        getMock.mockResolvedValue({ data: [] });

        const outcome = await addOrMonitorAlbum(lookup, 'rel-spotify', settings, 'key');

        expect(outcome).toEqual({ result: 'failed', ok: false, message: 'constraint failed\nNOT NULL constraint failed: Albums.Images' });
        expect(searches()).toHaveLength(0);
    });

    it('takes the album after a 409 when another add got it in first', async () => {
        rejectAdd(409, { message: 'constraint failed\nUNIQUE constraint failed: Albums.ForeignAlbumId' });

        const outcome = await addOrMonitorAlbum(lookup, 'rel-spotify', settings, 'key');

        expect(searches()).toHaveLength(1);
        expect(outcome).toMatchObject({ result: 'existing', ok: true });
    });

    // With Lidarr's own search off, an add that timed out but went through must still end in a search
    it('retries an add that timed out, and takes the album when the retry meets "already added"', async () => {
        let attempts = 0;
        postMock.mockImplementation(async (url: string) => {
            if (!url.endsWith('/api/v1/album'))
                return { data: {} };

            attempts++;
            if (attempts === 1)
                throw Object.assign(new Error('timeout of 30000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' });

            throw Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: alreadyAdded } });
        });

        vi.useFakeTimers();
        const outcome = await (async () => {
            try {
                const pending = addOrMonitorAlbum(lookup, 'rel-spotify', settings, 'key');
                await vi.advanceTimersByTimeAsync(5000);

                return await pending;
            } finally {
                vi.useRealTimers();
            }
        })();

        expect(attempts).toBe(2);
        expect(outcome).toMatchObject({ result: 'existing', ok: true });
        expect(putMock.mock.calls[0]?.[1]).toMatchObject({ anyReleaseOk: false });
        expect(searches()).toHaveLength(1);
    });

    it('searches without pinning when no release is known', async () => {
        await addOrMonitorAlbum(lookup, undefined, settings, 'key');

        expect(putMock).not.toHaveBeenCalled();
        expect(searches()).toHaveLength(1);
    });

    // The default: downloads come from slskd, Deezer or Tidal, whose edition often is not Spotify's
    describe('with pinning off', () => {
        it('leaves any release importable, monitors and searches once', async () => {
            const outcome = await addOrMonitorAlbum(lookup, 'rel-spotify', unpinned, 'key');

            expect(adds()[0]?.[1]).toMatchObject({ anyReleaseOk: true });
            expect(putMock).not.toHaveBeenCalled();
            expect(searches()).toHaveLength(1);
            expect(outcome).toMatchObject({ result: 'added', ok: true, message: 'Album already monitored, search triggered' });
        });

        it('monitors an unmonitored album Lidarr has without touching its releases', async () => {
            getMock.mockResolvedValue({ data: [{ id: 7, foreignAlbumId: 'rg-1', title: 'Hooked', monitored: false, artistId: 1, anyReleaseOk: true, releases, statistics: { trackFileCount: 0, totalTrackCount: 1 } }] });

            await addOrMonitorAlbum({ ...lookup, id: 7 }, 'rel-spotify', unpinned, 'key');

            expect(putMock.mock.calls[0]?.[1]).toMatchObject({ monitored: true, anyReleaseOk: true, releases });
            expect(searches()).toHaveLength(1);
        });

        // Pinning was unconditional before the setting, so an upgrade leaves such albums pinned
        it("frees an empty album an earlier send pinned to Spotify's release", async () => {
            const pinned = releases.map(release => ({ ...release, monitored: release.foreignReleaseId === 'rel-spotify' }));
            getMock.mockResolvedValue({ data: [{ id: 7, foreignAlbumId: 'rg-1', title: 'Hooked', monitored: true, artistId: 1, anyReleaseOk: false, releases: pinned, statistics: { trackFileCount: 0, totalTrackCount: 1 } }] });

            await addOrMonitorAlbum({ ...lookup, id: 7 }, 'rel-spotify', unpinned, 'key');

            expect(putMock.mock.calls[0]?.[1]).toMatchObject({ anyReleaseOk: true, releases: pinned });
            expect(searches()).toHaveLength(1);
        });
    });

    describe("a new album's releases, which Lidarr loads after the add", () => {
        const notLoaded = { data: [{ id: 7, foreignAlbumId: 'rg-1', title: 'Hooked', monitored: true, artistId: 1, anyReleaseOk: true, releases: [] }] };

        beforeEach(() => { vi.useFakeTimers() });
        afterEach(() => { vi.useRealTimers() });

        // Releases arrive before the tracks; until the tracks do, Lidarr sends no statistics to tell an empty album by
        it('are waited for, with their tracks, then the release is pinned and searched once', async () => {
            const loaded = await getMock();
            const releasesOnly = { data: [{ ...notLoaded.data[0], releases }] };
            getMock.mockReset();
            getMock.mockResolvedValueOnce(notLoaded).mockResolvedValueOnce(releasesOnly)
                .mockResolvedValueOnce(releasesOnly)
                .mockResolvedValue(loaded);

            const pending = addOrMonitorAlbum(lookup, 'rel-spotify', settings, 'key');
            await vi.advanceTimersByTimeAsync(10_000);
            const outcome = await pending;

            expect(putMock.mock.calls[0]?.[1]).toMatchObject({ anyReleaseOk: false });
            expect(searches()).toHaveLength(1);
            expect(outcome.message).toBe("Album already monitored, Spotify's release selected, search triggered");
        });

        it('that never load still get a search, and the message says nothing was selected', async () => {
            getMock.mockResolvedValue(notLoaded);

            const pending = addOrMonitorAlbum(lookup, 'rel-spotify', settings, 'key');
            await vi.advanceTimersByTimeAsync(120_000);
            const outcome = await pending;

            expect(putMock).not.toHaveBeenCalled();
            expect(searches()).toHaveLength(1);
            expect(outcome.message).toContain("Lidarr had not loaded the album's releases yet, so none was selected");
        });

        // The wait gives up at 90 s; the read after it decides the pin, so the message follows that read
        it('that load just after the wait gives up are still pinned, and the message says so', async () => {
            const loaded = await getMock();
            const start = Date.now();
            let readsAtDeadline = 0;
            getMock.mockReset();
            getMock.mockImplementation(async () => {
                if (Date.now() - start < 90_000)
                    return notLoaded;

                readsAtDeadline++;

                return readsAtDeadline === 1 ? notLoaded : loaded;
            });

            const pending = addOrMonitorAlbum(lookup, 'rel-spotify', settings, 'key');
            await vi.advanceTimersByTimeAsync(120_000);
            const outcome = await pending;

            expect(putMock.mock.calls[0]?.[1]).toMatchObject({ anyReleaseOk: false });
            expect(outcome.message).toBe("Album already monitored, Spotify's release selected, search triggered");
        });
    });

    it("reports Lidarr's reason for refusing the add, and searches nothing", async () => {
        rejectAdd(400, [{ errorMessage: 'Root folder path does not exist' }]);

        const outcome = await addOrMonitorAlbum(lookup, 'rel-spotify', settings, 'key');

        expect(outcome).toEqual({ result: 'failed', ok: false, message: 'Root folder path does not exist' });
        expect(searches()).toHaveLength(0);
    });

    describe('against a Lidarr that loads the releases after the add', () => {
        beforeEach(() => { vi.useFakeTimers() });
        afterEach(() => { vi.useRealTimers() });

        async function settle<T>(pending: Promise<T>) {
            await vi.advanceTimersByTimeAsync(120_000);

            return pending;
        }

        it('pins, then searches once, after a clean add', async () => {
            const lidarr = fakeLidarr();

            const outcome = await settle(addOrMonitorAlbum(lookup, 'rel-spotify', settings, 'key'));

            expect(outcome).toMatchObject({ result: 'added', ok: true });
            expect(lidarr.searches).toEqual([{ pinned: true }]);
        });

        // The retry meets "already added" for the album its own first attempt saved
        it('waits for the releases when an add timed out after Lidarr saved it', async () => {
            const lidarr = fakeLidarr({ firstAddTimesOutAfterSaving: true });

            const outcome = await settle(addOrMonitorAlbum(lookup, 'rel-spotify', settings, 'key'));

            expect(lidarr.addAttempts).toBe(2);
            expect(outcome).toMatchObject({ result: 'existing', ok: true });
            expect(lidarr.searches).toEqual([{ pinned: true }]);
        });

        // The web "send album" endpoint and the nightly job can send the same album at once
        it('searches only pinned when another sender added the album first', async () => {
            const lidarr = fakeLidarr();

            const first = addOrMonitorAlbum(lookup, 'rel-spotify', settings, 'key');
            await vi.advanceTimersByTimeAsync(100);
            await settle(Promise.all([first, addOrMonitorAlbum(lookup, 'rel-spotify', settings, 'key')]));

            expect(lidarr.searches.length).toBeGreaterThan(0);
            expect(lidarr.searches.every(s => s.pinned)).toBe(true);
        });
    });
});
