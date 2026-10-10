// ==UserScript==
// @name         TwitchVOD
// @namespace    https://github.com/besuper/TwitchNoSub
// @version      0.9.5
// @description  Show sub-only VODs on Twitch by patching the Amazon playback worker and stripping preview-card restrictions.
// @author       besuper
// @match        https://*.twitch.tv/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// @grant none is required, not stylistic. It puts this script in Twitch's own
// JS context so the `window.Worker` override below is visible to the player.
// Adding any other @grant makes managers run this in a sandbox, where the
// override silently does nothing and the patch stops working with no error.
//
// @match is https-only on purpose: the scheme wildcard `*://` also matches
// cleartext http://, which would let a network attacker substitute the worker
// source this script re-hosts.
//
// Two independent pieces of work:
//   1. Twitch hands playback to a Web Worker whose WASM refuses sub-only VODs.
//      We re-create that worker with our patch prepended to its source.
//   2. Preview cards in the UI carry a "subscriber only" overlay. We strip it.
//
// Everything this needs is inlined below. It never fetches *code* from a remote
// host — see vendoredWorkerPatch() for the formerly-remote code. (The vendored
// patch does still talk to Twitch's GQL endpoint and the VOD CDN at runtime,
// since that is how it finds the VOD's playlists.)

(function () {
    'use strict';

    /* ------------------------------------------------------------------ */
    /* 1. Worker patch (vendored)                                          */
    /* ------------------------------------------------------------------ */

    /**
     * The player patch that used to be fetched at runtime from
     * cdn.jsdelivr.net/gh/besuper/TwitchNoSub@master/src/patch_amazonworker.js.
     *
     * It is vendored here rather than fetched because that URL pointed at a
     * *branch*, not a commit SHA: whoever controls that GitHub account could
     * ship arbitrary code into a twitch.tv-origin worker for every installed
     * user, with their session usable against authenticated same-origin
     * endpoints. Vendoring removes that trust question entirely.
     *
     * It lives as a real function (not a template-literal string) because it
     * contains its own backticks and ${} interpolations, which an enclosing
     * template literal would try to evaluate. Function.prototype.toString
     * reproduces it verbatim with no escaping to get wrong. Keep it in sync by
     * replacing this function body wholesale.
     *
     * Upstream: besuper/TwitchNoSub, src/patch_amazonworker.js
     */
    function vendoredWorkerPatch() {
        async function fetchTwitchDataGQL(vodID) {
            const resp = await fetch("https://gql.twitch.tv/gql", {
                method: 'POST',
                body: JSON.stringify({
                    "query": "query { video(id: \"" + vodID + "\") { broadcastType, createdAt, seekPreviewsURL, owner { login } }}"
                }),
                headers: {
                    'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            return resp.json();
        }

        function createServingID() {
            const w = "0123456789abcdefghijklmnopqrstuvwxyz".split("");
            let id = "";

            for (let i = 0; i < 32; i++) {
                id += w[Math.floor(Math.random() * w.length)];
            }

            return id;
        }

        const defaultResolutions = (() => {
            const _defaultResolutions = {
                "160p30": { "name": "160p", "resolution": "284x160", "frameRate": 30 },
                "360p30": { "name": "360p", "resolution": "640x360", "frameRate": 30 },
                "480p30": { "name": "480p", "resolution": "854x480", "frameRate": 30 },
                "720p60": { "name": "720p60", "resolution": "1280x720", "frameRate": 60 },
                "1080p60": { "name": "1080p60", "resolution": "1920x1080", "frameRate": 60 },
                "1440p60": { "name": "1440p60", "resolution": "2560x1440", "frameRate": 60 },
                "chunked": { "name": "chunked", "resolution": "chunked", "frameRate": 60 }
            };

            let sorted_dict = Object.keys(_defaultResolutions);
            sorted_dict = sorted_dict.reverse();

            let ordered_resolutions = {};

            for (const key in sorted_dict) {
                ordered_resolutions[sorted_dict[key]] = _defaultResolutions[sorted_dict[key]];
            }

            return ordered_resolutions;
        })();

        async function isValidQuality(url) {
            const response = await fetch(url, { cache: "force-cache" });

            if (response.ok) {
                const data = await response.text();

                if (data.includes(".ts")) {
                    // ts files should still use the h264
                    return { codec: "avc1.4D001E" };
                }

                if (data.includes(".mp4")) {
                    // mp4 file use h265, but sometimes h264
                    const mp4Request = await fetch(url.replace("index-dvr.m3u8", "init-0.mp4"), { cache: "force-cache" });

                    if (mp4Request.ok) {
                        const content = await mp4Request.text();

                        return { codec: content.includes("hev1") ? "hev1.1.6.L93.B0" : "avc1.4D001E" };
                    }

                    return { codec: "hev1.1.6.L93.B0" };
                }
            }

            return null;
        }

        // VOD playlists are only ever fetched from hosts matching this pattern.
        // The host comes out of an API response, so validate it rather than
        // blindly building URLs from it. Edit here if Twitch moves its CDN.
        const ALLOWED_VOD_HOSTS = /(^|\.)(cloudfront\.net|ttvnw\.net|twitch\.tv)$/i;

        // Usher URLs carry the playback token and signature in the query string.
        // Never log those.
        function redactUrl(u) {
            return String(u).split("?")[0];
        }

        const oldFetch = self.fetch;

        self.fetch = async function (input, opt) {
            let url = input instanceof Request ? input.url : input.toString();
            let response = await oldFetch(input, opt);

            // Patch playlist from unmuted to muted segments
            if (url.includes("cloudfront") && url.includes(".m3u8") && response.ok) {
                const body = await response.text();

                // The body length changes and has already been decoded, so the
                // original length/encoding headers would now be wrong.
                const headers = new Headers(response.headers);
                headers.delete("content-length");
                headers.delete("content-encoding");

                return new Response(body.replace(/-unmuted/g, "-muted"), {
                    status: response.status,
                    statusText: response.statusText,
                    headers
                });
            }

            if (url.startsWith("https://usher.ttvnw.net/vod/")) {
                console.log(`[TNS] Usher request intercepted (status ${response.status}): ${redactUrl(url)}`);

                if (response.status != 200) {
                    const isUsherV2 = url.includes("/vod/v2");

                    console.log(`[TNS] Detected usher ${isUsherV2 ? 'v2' : 'v1'}`);

                    const splitUsher = url.split(".m3u8")[0].split("/");

                    const vodId = splitUsher.at(-1);

                    // The ID is interpolated into a GQL query string; only accept
                    // plain numeric IDs and leave anything else untouched.
                    if (!/^\d+$/.test(vodId)) {
                        console.log("[TNS] Unexpected VOD id format, not patching");
                        return response;
                    }

                    let data = null;

                    try {
                        data = await fetchTwitchDataGQL(vodId);
                    } catch (error) {
                        console.log("[TNS] GQL request failed", error);
                    }

                    if (!data || !data?.data?.video) {
                        console.log("[TNS] Unable to fetch twitch data API", data);
                        return new Response("Unable to fetch twitch data API", { status: 403 });
                    }

                    console.log(`[TNS] Found data for VOD ${vodId}`);

                    const vodData = data.data.video;
                    const channelData = vodData.owner;

                    // Twitch sometimes returns a null seekPreviewsURL (e.g. storyboards disabled),
                    // which previously crashed the whole patch. Log clearly so the failure is diagnosable.
                    if (!vodData.seekPreviewsURL) {
                        console.log("[TNS] seekPreviewsURL is missing, cannot build playlist", vodData);
                        return new Response("Missing seekPreviewsURL", { status: 403 });
                    }

                    const currentURL = new URL(vodData.seekPreviewsURL);

                    if (currentURL.protocol !== "https:" || !ALLOWED_VOD_HOSTS.test(currentURL.hostname)) {
                        console.log("[TNS] Refusing unexpected VOD host:", currentURL.hostname);
                        return new Response("Unexpected VOD host", { status: 403 });
                    }

                    const domain = currentURL.host;
                    const paths = currentURL.pathname.split("/");
                    const storyboardsIndex = paths.findIndex(element => element.includes("storyboards"));

                    if (storyboardsIndex < 1) {
                        console.log("[TNS] No 'storyboards' segment in seekPreviewsURL, cannot derive VOD id", redactUrl(vodData.seekPreviewsURL));
                        return new Response("Unrecognised seekPreviewsURL layout", { status: 403 });
                    }

                    const vodSpecialID = paths[storyboardsIndex - 1];

                    console.log(`[TNS] Channel: ${channelData?.login}, broadcastType: ${vodData.broadcastType}, domain: ${domain}, vodSpecialID: ${vodSpecialID}`);

                    let fakePlaylist = `#EXTM3U
#EXT-X-TWITCH-INFO:ORIGIN="s3",B="false",REGION="EU",USER-IP="127.0.0.1",SERVING-ID="${createServingID()}",CLUSTER="cloudfront_vod",USER-COUNTRY="BE",MANIFEST-CLUSTER="cloudfront_vod"`;

                    const now = new Date();
                    const created = new Date(vodData.createdAt);

                    const time_difference = now.getTime() - created.getTime();
                    const days_difference = time_difference / (1000 * 3600 * 24);

                    const broadcastType = String(vodData.broadcastType || "").toLowerCase();

                    let startQuality = 8534030;

                    const candidates = [];

                    for (const [resKey, resValue] of Object.entries(defaultResolutions)) {
                        let playlistUrl = undefined;

                        if (broadcastType === "highlight") {
                            playlistUrl = `https://${domain}/${vodSpecialID}/${resKey}/highlight-${vodId}.m3u8`;
                        } else if (broadcastType === "upload" && days_difference > 7 && channelData?.login) {
                            // Only old uploaded VOD works with this method now
                            playlistUrl = `https://${domain}/${channelData.login}/${vodId}/${vodSpecialID}/${resKey}/index-dvr.m3u8`;
                        } else {
                            playlistUrl = `https://${domain}/${vodSpecialID}/${resKey}/index-dvr.m3u8`;
                        }

                        candidates.push({ resKey, resValue, playlistUrl });
                    }

                    // Probe every quality at once; a network error just means "not available".
                    const probes = await Promise.all(
                        candidates.map(({ playlistUrl }) => isValidQuality(playlistUrl).catch(() => null))
                    );

                    // Build the playlist in the original (highest-first) order.
                    for (let i = 0; i < candidates.length; i++) {
                        const { resKey, resValue, playlistUrl } = candidates[i];
                        const result = probes[i];

                        if (!result) continue;

                        console.log(`[TNS] Found quality ${resKey}`);

                        if (isUsherV2) {
                            const variantSource = resKey == "chunked" ? "source" : "transcode";

                            fakePlaylist += `
#EXT-X-STREAM-INF:BANDWIDTH=${startQuality},CODECS="${result.codec},mp4a.40.2",RESOLUTION=${resValue.resolution},FRAME-RATE=${resValue.frameRate},STABLE-VARIANT-ID="${resKey}",IVS-NAME="${resValue.name}",IVS-VARIANT-SOURCE="${variantSource}"
${playlistUrl}`;
                        } else {
                            const enabled = resKey == "chunked" ? "YES" : "NO";

                            fakePlaylist += `
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="${resKey}",NAME="${resKey}",AUTOSELECT=${enabled},DEFAULT=${enabled}
#EXT-X-STREAM-INF:BANDWIDTH=${startQuality},CODECS="${result.codec},mp4a.40.2",RESOLUTION=${resValue.resolution},VIDEO="${resValue.name}",FRAME-RATE=${resValue.frameRate}
${playlistUrl}`;
                        }

                        startQuality -= 100;
                    }

                    if (!fakePlaylist.includes("#EXT-X-STREAM-INF")) {
                        console.log("[TNS] No valid quality found, the VOD CDN structure may have changed", { domain, vodSpecialID, broadcastType, login: channelData?.login });
                        return new Response("No valid quality found", { status: 403 });
                    }

                    const header = new Headers();
                    header.append('Content-Type', 'application/vnd.apple.mpegurl');

                    console.log("[TNS] Serving generated playlist");

                    return new Response(fakePlaylist, { status: 200, headers: header });
                }
            }

            return response;
        };
    }

    /** The vendored patch, as source text, to prepend to the player's source. */
    const WORKER_PATCH_SOURCE = `(${vendoredWorkerPatch})();\n`;

    /* ------------------------------------------------------------------ */
    /* 2. Worker re-hosting                                                */
    /* ------------------------------------------------------------------ */

    const RESTRICTION_CLASS = 'video-preview-card-restriction';

    /** Fallback revoke in case the worker never emits anything at all. */
    const WORKER_BLOB_REVOKE_MS = 30000;

    const LOG_PREFIX = '[TNS]';

    // Guards against accidental double execution (script re-injection, frame
    // reuse), which would nest the wrapper and refetch the player source.
    // Not a security control: this is a writable page global under @grant
    // none, so anything already on the page could set or clear it.
    if (window.__TwitchNoSub) {
        return;
    }
    window.__TwitchNoSub = true;

    console.log(LOG_PREFIX, 'loaded');

    /** Worker sources by URL, including cached misses, so we fetch at most once each. */
    const workerSourceCache = new Map();

    /** Worker sources are multi-MB; keep only the most recent one. */
    const WORKER_CACHE_MAX_ENTRIES = 1;

    /**
     * Only re-host same-origin blob workers.
     *
     * Twitch builds the player worker from a blob URL. Anything else on the
     * page must be left alone: re-hosting a foreign URL would silently promote
     * that worker to the twitch.tv origin (and past the CORS check the browser
     * would otherwise have applied to it).
     */
    function shouldPatchWorker(scriptUrl) {
        if (typeof scriptUrl !== 'string') {
            return false;
        }

        try {
            const url = new URL(scriptUrl, location.href);
            return url.protocol === 'blob:' && url.origin === location.origin;
        } catch {
            return false;
        }
    }

    /**
     * Read the player's worker source so it can be re-hosted in a blob we
     * control. Must stay synchronous: the Worker constructor needs a URL now,
     * and there is no way to await a fetch before calling super(). Note that
     * XMLHttpRequest.timeout is ignored for synchronous requests, so this
     * blocks the main thread for the whole download.
     */
    function readWorkerSource(url) {
        if (workerSourceCache.has(url)) {
            return workerSourceCache.get(url);
        }

        let source = null;

        try {
            const request = new XMLHttpRequest();
            request.open('GET', url, false);
            request.overrideMimeType('text/javascript');
            request.send();

            // Without this check a 403/404 or a WAF interstitial HTML page comes
            // back non-empty and gets spliced into the blob as "worker source",
            // which surfaces as an opaque syntax error instead of a clean
            // fallback. Blob fetches report status 0 in some browsers.
            if (request.status === 200 || request.status === 0) {
                const text = request.responseText;
                if (typeof text === 'string' && text.length > 0) {
                    source = text;
                }
            }
        } catch (error) {
            console.warn(LOG_PREFIX, 'could not read worker source:', error);
        }

        // Cache misses too, so a failing URL isn't retried on every worker.
        // Bounded so full copies of the player source can't pile up.
        if (workerSourceCache.size >= WORKER_CACHE_MAX_ENTRIES) {
            workerSourceCache.clear();
        }
        workerSourceCache.set(url, source);
        return source;
    }

    /**
     * Build a blob URL running our patch first, then Twitch's source verbatim.
     * Returns null when the worker isn't one of ours or its source is
     * unreadable, so the caller can fall back to the untouched original.
     */
    function buildPatchedWorkerUrl(originalUrl) {
        if (!shouldPatchWorker(originalUrl)) {
            return null;
        }

        const source = readWorkerSource(originalUrl);
        if (!source) {
            return null;
        }

        return URL.createObjectURL(new Blob([WORKER_PATCH_SOURCE, source]));
    }

    /**
     * Release the blob once the worker has certainly fetched it. Revoking
     * immediately after super() would race, because the spec queues the worker
     * script fetch as a task rather than performing it inside the constructor.
     */
    function releaseWorkerBlob(worker, blobUrl) {
        let released = false;

        const release = () => {
            if (released) return;
            released = true;

            URL.revokeObjectURL(blobUrl);
            worker.removeEventListener('message', release);
            worker.removeEventListener('error', release);
        };

        worker.addEventListener('message', release, { once: true });
        worker.addEventListener('error', release, { once: true });
        setTimeout(release, WORKER_BLOB_REVOKE_MS);
    }

    const NativeWorker = window.Worker;
    let loggedSkip = false;

    window.Worker = class PatchedWorker extends NativeWorker {
        constructor(...args) {
            const [scriptUrl, workerOptions] = args;

            const patchedUrl = buildPatchedWorkerUrl(scriptUrl);

            if (!patchedUrl) {
                if (!loggedSkip) {
                    loggedSkip = true;
                    console.log(LOG_PREFIX, 'worker not patched, leaving native:', scriptUrl);
                }
                super(...args);
                return;
            }

            super(patchedUrl, workerOptions);
            releaseWorkerBlob(this, patchedUrl);
        }
    };

    /* ------------------------------------------------------------------ */
    /* 3. Preview card restriction remover                                */
    /* ------------------------------------------------------------------ */

    function removeRestrictionsWithin(root) {
        if (root.nodeType !== Node.ELEMENT_NODE) {
            return;
        }

        if (root.classList.contains(RESTRICTION_CLASS)) {
            root.remove();
            return;
        }

        root.querySelectorAll(`.${RESTRICTION_CLASS}`).forEach((restriction) => {
            restriction.remove();
        });
    }

    let restrictionObserver = null;

    function startRestrictionRemover() {
        if (restrictionObserver) {
            return;
        }

        // Catch anything already rendered before we started observing.
        document.querySelectorAll(`.${RESTRICTION_CLASS}`).forEach((element) => {
            element.remove();
        });

        restrictionObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    removeRestrictionsWithin(node);
                }
            }
        });

        restrictionObserver.observe(document.body, { childList: true, subtree: true });
    }

    function stopRestrictionRemover() {
        if (restrictionObserver) {
            restrictionObserver.disconnect();
            restrictionObserver = null;
        }
    }

    // Twitch keeps the document alive across SPA navigation, so the observer
    // only needs to stop when the page really goes away. If the page is later
    // restored from the back/forward cache, pagehide has already stopped the
    // observer and no new load event will run, so restart it on pageshow.
    window.addEventListener('pagehide', stopRestrictionRemover);
    window.addEventListener('pageshow', (event) => {
        if (event.persisted) {
            startRestrictionRemover();
        }
    });

    // document-start normally lands well before DOMContentLoaded, but if the
    // manager ever injects late the listener would never fire and the remover
    // would silently never start.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startRestrictionRemover, {
            once: true,
        });
    } else {
        startRestrictionRemover();
    }
})();
