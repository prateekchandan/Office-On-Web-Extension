/*
========================= browser_api.js ==============================
*/
// Copyright 2015 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/**
 * @param {!Object} streamInfo The stream object pointing to the data contained
 *     in the PDF.
 * @return {Promise<number>} A promise that will resolve to the default zoom
 *     factor.
 */
function lookupDefaultZoom(streamInfo) {
    // Webviews don't run in tabs so |streamInfo.tabId| is -1 when running within
    // a webview.
    if (!chrome.tabs || streamInfo.tabId < 0) {
        return Promise.resolve(1);
    }

    return new Promise(function (resolve, reject) {
        chrome.tabs.getZoomSettings(streamInfo.tabId, function (zoomSettings) {
            resolve(zoomSettings.defaultZoomFactor);
        });
    });
}

/**
 * Returns a promise that will resolve to the initial zoom factor
 * upon starting the plugin. This may differ from the default zoom
 * if, for example, the page is zoomed before the plugin is run.
 * @param {!Object} streamInfo The stream object pointing to the data contained
 *     in the PDF.
 * @return {Promise<number>} A promise that will resolve to the initial zoom
 *     factor.
 */
function lookupInitialZoom(streamInfo) {
    // Webviews don't run in tabs so |streamInfo.tabId| is -1 when running within
    // a webview.
    if (!chrome.tabs || streamInfo.tabId < 0) {
        return Promise.resolve(1);
    }

    return new Promise(function (resolve, reject) {
        chrome.tabs.getZoom(streamInfo.tabId, resolve);
    });
}

// A class providing an interface to the browser.
class BrowserApi {
    /**
     * @param {!Object} streamInfo The stream object which points to the data
     *     contained in the PDF.
     * @param {number} defaultZoom The default browser zoom.
     * @param {number} initialZoom The initial browser zoom
     *     upon starting the plugin.
     * @param {BrowserApi.ZoomBehavior} zoomBehavior How to manage zoom.
     */
    constructor(streamInfo, defaultZoom, initialZoom, zoomBehavior) {
        this.streamInfo_ = streamInfo;
        this.defaultZoom_ = defaultZoom;
        this.initialZoom_ = initialZoom;
        this.zoomBehavior_ = zoomBehavior;
    }

    /**
     * @param {!Object} streamInfo The stream object pointing to the data
     *     contained in the PDF.
     * @param {BrowserApi.ZoomBehavior} zoomBehavior How to manage zoom.
     * @return {Promise<BrowserApi>} A promise to a BrowserApi.
     */
    static create(streamInfo, zoomBehavior) {
        return Promise.all([
            lookupDefaultZoom(streamInfo),
            lookupInitialZoom(streamInfo)
        ]).then(function (zoomFactors) {
            return new BrowserApi(
                streamInfo,
                zoomFactors[0],
                zoomFactors[1],
                zoomBehavior
            );
        });
    }

    /**
     * @return {Object} The stream info object pointing to the data contained in
     *     the PDF.
     */
    getStreamInfo() {
        return this.streamInfo_;
    }

    /**
     * Sets the browser zoom.
     * @param {number} zoom The zoom factor to send to the browser.
     * @return {Promise} A promise that will be resolved when the browser zoom
     *     has been updated.
     */
    setZoom(zoom) {
        assert(
            this.zoomBehavior_ === BrowserApi.ZoomBehavior.MANAGE,
            'Viewer does not manage browser zoom.'
        );
        return new Promise((resolve, reject) => {
            chrome.tabs.setZoom(this.streamInfo_.tabId, zoom, resolve);
        });
    }

    /** @return {number} The default browser zoom factor. */
    getDefaultZoom() {
        return this.defaultZoom_;
    }

    /** @return {number} The initial browser zoom factor. */
    getInitialZoom() {
        return this.initialZoom_;
    }

    /** @return {BrowserApi.ZoomBehavior} How to manage zoom. */
    getZoomBehavior() {
        return this.zoomBehavior_;
    }

    /**
     * Adds an event listener to be notified when the browser zoom changes.
     *
     * @param {!Function} listener The listener to be called with the new zoom
     *     factor.
     */
    addZoomEventListener(listener) {
        if (
            !(
                this.zoomBehavior_ === BrowserApi.ZoomBehavior.MANAGE ||
                this.zoomBehavior_ === BrowserApi.ZoomBehavior.PROPAGATE_PARENT
            )
        ) {
            return;
        }

        chrome.tabs.onZoomChange.addListener((info) => {
            const zoomChangeInfo = /** @type {{tabId: number, newZoomFactor: number}} */ (info);
            if (zoomChangeInfo.tabId !== this.streamInfo_.tabId) {
                return;
            }
            listener(zoomChangeInfo.newZoomFactor);
        });
    }
}

/**
 * Enumeration of ways to manage zoom changes.
 * @enum {number}
 */
BrowserApi.ZoomBehavior = {
    NONE: 0,
    MANAGE: 1,
    PROPAGATE_PARENT: 2
};

/**
 * Creates a BrowserApi for an extension running as a mime handler.
 * @return {!Promise<!BrowserApi>} A promise to a BrowserApi instance
 *     constructed using the mimeHandlerPrivate API.
 */
function createBrowserApiForMimeHandlerView() {
    return new Promise(function (resolve, reject) {
        chrome.mimeHandlerPrivate.getStreamInfo(resolve);
    }).then(function (streamInfo) {
        const promises = [];
        let zoomBehavior = BrowserApi.ZoomBehavior.NONE;
        if (streamInfo.tabId !== -1) {
            zoomBehavior = streamInfo.embedded
                ? BrowserApi.ZoomBehavior.PROPAGATE_PARENT
                : BrowserApi.ZoomBehavior.MANAGE;
            promises.push(
                new Promise(function (resolve) {
                    chrome.tabs.get(streamInfo.tabId, resolve);
                }).then(function (tab) {
                    if (tab) {
                        streamInfo.tabUrl = tab.url;
                    }
                })
            );
        }
        if (zoomBehavior === BrowserApi.ZoomBehavior.MANAGE) {
            promises.push(
                new Promise(function (resolve) {
                    chrome.tabs.setZoomSettings(
                        streamInfo.tabId,
                        { mode: 'manual', scope: 'per-tab' },
                        resolve
                    );
                })
            );
        }
        return Promise.all(promises).then(function () {
            return BrowserApi.create(streamInfo, zoomBehavior);
        });
    });
}

/**
 * Creates a BrowserApi instance for an extension not running as a mime handler.
 * @return {!Promise<!BrowserApi>} A promise to a BrowserApi instance
 *     constructed from the URL.
 */
function createBrowserApiForPrintPreview() {
    const url = window.location.search.substring(1);
    const streamInfo = {
        streamUrl: url,
        originalUrl: url,
        responseHeaders: {},
        embedded: window.parent !== window,
        tabId: -1
    };
    return new Promise(function (resolve, reject) {
        if (!chrome.tabs) {
            resolve();
            return;
        }
        chrome.tabs.getCurrent(function (tab) {
            streamInfo.tabId = tab.id;
            streamInfo.tabUrl = tab.url;
            resolve();
        });
    }).then(function () {
        return BrowserApi.create(streamInfo, BrowserApi.ZoomBehavior.NONE);
    });
}

/**
 * @return {!Promise<!BrowserApi>} A promise to a BrowserApi instance for the
 *     current environment.
 */
function createBrowserApi() {
    if (location.origin === 'chrome://print') {
        return createBrowserApiForPrintPreview();
    }

    return createBrowserApiForMimeHandlerView();
}

/*
========================= END browser_api.js ==============================
*/

browser_api = createBrowserApiForMimeHandlerView();

/**
 * Convert an Uint8Array into a string.
 *
 * @returns {String}
 */
function Decodeuint8arr(uint8array) {
    return new TextDecoder('utf-8').decode(uint8array);
}

function GetDocumentTypeHadler(mimeType) {
    switch (mimeType) {
        case 'application/msword':
        case 'application/vnd.ms-word':
        case 'application/vnd.msword':
        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        case 'application/vnd.wordprocessing-openxml':
        case 'application/vnd.ces-quickword':
        case 'application/vnd.ms-word.document.macroEnabled.12':
        case 'application/vnd.ms-word.document.macroenabled.12':
        case 'application/vnd.ms-word.document.12':
            return 'ms-word';
        case 'application/mspowerpoint':
        case 'application/vnd.ms-powerpoint':
        case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
        case 'application/vnd.ces-quickpoint':
        case 'application/vnd.presentation-openxml':
        case 'application/vnd.presentation-openxmlm':
        case 'application/vnd.ms-powerpoint.presentation.macroEnabled.12':
        case 'application/vnd.ms-powerpoint.presentation.macroenabled.12':
            return 'ms-powerpoint';
        case 'application/msexcel':
        case 'application/vnd.ms-excel':
        case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        case 'application/vnd.ces-quicksheet':
        case 'application/vnd.spreadsheet-openxml':
        case 'application/vnd.ms-excel.sheet.macroEnabled.12':
        case 'application/vnd.ms-excel.sheet.macroenabled.12':
        case 'text/csv':
            return 'ms-excel';
    }
}

function GetURLPrefixForMimeType(type) {
    switch (GetDocumentTypeHadler(type)) {
        case 'ms-word':
            return 'wordcs';
        case 'ms-powerpoint':
            return 'pptcs';
        case 'ms-excel':
            return 'excelcs';
    }
}

function GetUrlExtension(url) {
    return url.split(/[#?]/)[0].split('.').pop().trim();
}

async function OnGetStreamData(stream, streamInfo) {
    var link =
        'https://graph.microsoft.com/v1.0/me/drive/root:/localFiles/test.' +
        GetUrlExtension(streamInfo.originalUrl) +
        ':/content?@name.conflictBehavior=replace';
    var xhr = new XMLHttpRequest();
    xhr.open('PUT', link, true);
    xhr.setRequestHeader('Content-type', 'application/octet-stream');
    // TODO: Instead of harcoding aut token, get actual one
    xhr.setRequestHeader(
        'Authorization',
        'Bearer ' + 'eyJ0eXAiOiJKV1QiLCJub25jZSI6IndISzltenVNVEFYNm9qa2xXNzhFY1lCNzdtcTV1SHl6Q1VXbC1hVUtaWkkiLCJhbGciOiJSUzI1NiIsIng1dCI6Im5PbzNaRHJPRFhFSzFqS1doWHNsSFJfS1hFZyIsImtpZCI6Im5PbzNaRHJPRFhFSzFqS1doWHNsSFJfS1hFZyJ9.eyJhdWQiOiIwMDAwMDAwMy0wMDAwLTAwMDAtYzAwMC0wMDAwMDAwMDAwMDAiLCJpc3MiOiJodHRwczovL3N0cy53aW5kb3dzLm5ldC83MmY5ODhiZi04NmYxLTQxYWYtOTFhYi0yZDdjZDAxMWRiNDcvIiwiaWF0IjoxNjE2NjEyMDQxLCJuYmYiOjE2MTY2MTIwNDEsImV4cCI6MTYxNjYxNTk0MSwiYWNjdCI6MCwiYWNyIjoiMSIsImFjcnMiOlsidXJuOnVzZXI6cmVnaXN0ZXJzZWN1cml0eWluZm8iLCJ1cm46bWljcm9zb2Z0OnJlcTIiLCJ1cm46bWljcm9zb2Z0OnJlcTMiLCJjMSIsImMyIiwiYzMiLCJjNCIsImM1IiwiYzYiLCJjNyIsImM4IiwiYzkiLCJjMTAiLCJjMTEiLCJjMTIiLCJjMTMiLCJjMTQiLCJjMTUiLCJjMTYiLCJjMTciLCJjMTgiLCJjMTkiLCJjMjAiLCJjMjEiLCJjMjIiLCJjMjMiLCJjMjQiLCJjMjUiXSwiYWlvIjoiQVZRQXEvOFRBQUFBT2lqeTI1N01haDJzMDBlK0tGRXhDVlhvWGQ3N1FJUzBHaVdORkN0cm1oL0U2dXVvZlgwQkxHdk5Xd2R2UUZkNEdaK2x5b3dLZW5RdTFiNWJEY3VOdTJweWpoVHdJa0JRZi9HY3ZhbmZSUTg9IiwiYW1yIjpbInB3ZCIsInJzYSIsIm1mYSJdLCJhcHBfZGlzcGxheW5hbWUiOiJHcmFwaCBleHBsb3JlciAob2ZmaWNpYWwgc2l0ZSkiLCJhcHBpZCI6ImRlOGJjOGI1LWQ5ZjktNDhiMS1hOGFkLWI3NDhkYTcyNTA2NCIsImFwcGlkYWNyIjoiMCIsImNvbnRyb2xzIjpbImFwcF9yZXMiXSwiY29udHJvbHNfYXVkcyI6WyJkZThiYzhiNS1kOWY5LTQ4YjEtYThhZC1iNzQ4ZGE3MjUwNjQiLCIwMDAwMDAwMy0wMDAwLTAwMDAtYzAwMC0wMDAwMDAwMDAwMDAiLCIwMDAwMDAwMy0wMDAwLTBmZjEtY2UwMC0wMDAwMDAwMDAwMDAiXSwiZGV2aWNlaWQiOiIwMTYwODNlYi03OGYwLTQ1YTYtOTdmOC04YmM1OTkwZDgzMGYiLCJmYW1pbHlfbmFtZSI6IkNoYW5kYW4iLCJnaXZlbl9uYW1lIjoiUHJhdGVlayIsImlkdHlwIjoidXNlciIsImlwYWRkciI6IjIwMi4xNjguODUuMTgzIiwibmFtZSI6IlByYXRlZWsgQ2hhbmRhbiIsIm9pZCI6ImI5NDIzMzYwLWNhZDEtNDA4Zi1hZmQyLTZhZjNhMTUzYTRiYSIsIm9ucHJlbV9zaWQiOiJTLTEtNS0yMS0yMTQ2NzczMDg1LTkwMzM2MzI4NS03MTkzNDQ3MDctMjExMzExMyIsInBsYXRmIjoiMyIsInB1aWQiOiIxMDAzQkZGRDk4ODk1NkU4IiwicmgiOiIwLkFSb0F2NGo1Y3ZHR3IwR1JxeTE4MEJIYlI3WElpOTc1MmJGSXFLMjNTTnB5VUdRYUFQdy4iLCJzY3AiOiJDYWxlbmRhcnMuUmVhZFdyaXRlIENvbnRhY3RzLlJlYWRXcml0ZSBEZXZpY2VNYW5hZ2VtZW50QXBwcy5SZWFkV3JpdGUuQWxsIERldmljZU1hbmFnZW1lbnRDb25maWd1cmF0aW9uLlJlYWQuQWxsIERldmljZU1hbmFnZW1lbnRDb25maWd1cmF0aW9uLlJlYWRXcml0ZS5BbGwgRGV2aWNlTWFuYWdlbWVudE1hbmFnZWREZXZpY2VzLlByaXZpbGVnZWRPcGVyYXRpb25zLkFsbCBEZXZpY2VNYW5hZ2VtZW50TWFuYWdlZERldmljZXMuUmVhZC5BbGwgRGV2aWNlTWFuYWdlbWVudE1hbmFnZWREZXZpY2VzLlJlYWRXcml0ZS5BbGwgRGV2aWNlTWFuYWdlbWVudFJCQUMuUmVhZC5BbGwgRGV2aWNlTWFuYWdlbWVudFJCQUMuUmVhZFdyaXRlLkFsbCBEZXZpY2VNYW5hZ2VtZW50U2VydmljZUNvbmZpZy5SZWFkLkFsbCBEZXZpY2VNYW5hZ2VtZW50U2VydmljZUNvbmZpZy5SZWFkV3JpdGUuQWxsIERpcmVjdG9yeS5BY2Nlc3NBc1VzZXIuQWxsIERpcmVjdG9yeS5SZWFkV3JpdGUuQWxsIEZpbGVzLlJlYWRXcml0ZS5BbGwgR3JvdXAuUmVhZFdyaXRlLkFsbCBJZGVudGl0eVJpc2tFdmVudC5SZWFkLkFsbCBNYWlsLlJlYWRXcml0ZSBNYWlsYm94U2V0dGluZ3MuUmVhZFdyaXRlIE5vdGVzLlJlYWRXcml0ZS5BbGwgb3BlbmlkIFBlb3BsZS5SZWFkIFByZXNlbmNlLlJlYWQgUHJlc2VuY2UuUmVhZC5BbGwgcHJvZmlsZSBSZXBvcnRzLlJlYWQuQWxsIFNpdGVzLlJlYWRXcml0ZS5BbGwgVGFza3MuUmVhZFdyaXRlIFVzZXIuUmVhZCBVc2VyLlJlYWRCYXNpYy5BbGwgVXNlci5SZWFkV3JpdGUgVXNlci5SZWFkV3JpdGUuQWxsIGVtYWlsIiwic2lnbmluX3N0YXRlIjpbImR2Y19tbmdkIiwiZHZjX2NtcCIsImttc2kiXSwic3ViIjoidng5MUZnM1RHZV9JVHN0OUE4TkpabDBpSElHS1RZV3VyNHdpeV9SVFlHWSIsInRlbmFudF9yZWdpb25fc2NvcGUiOiJXVyIsInRpZCI6IjcyZjk4OGJmLTg2ZjEtNDFhZi05MWFiLTJkN2NkMDExZGI0NyIsInVuaXF1ZV9uYW1lIjoicHJjaGFuQG1pY3Jvc29mdC5jb20iLCJ1cG4iOiJwcmNoYW5AbWljcm9zb2Z0LmNvbSIsInV0aSI6ImpfWkVVUzNtUkVPUkZyX2pJNG5rQUEiLCJ2ZXIiOiIxLjAiLCJ3aWRzIjpbImI3OWZiZjRkLTNlZjktNDY4OS04MTQzLTc2YjE5NGU4NTUwOSJdLCJ4bXNfc3QiOnsic3ViIjoiXzYzdUE3RjNWdHVOSFgyeGZ2VEZwTnNjNENCcVpVYnQxS1V2dFN5UkhUbyJ9LCJ4bXNfdGNkdCI6MTI4OTI0MTU0N30.Nf_MnDDGuC646_QJoIU9dpAwc_OjUSGq-89_AkROfFzmRWJFNcL6fZZe5TIzA4mZnbvSKFwdVrdfVqawNLyRoKH27jg91dSc7iqyNdQ47T9k1JHbJ9ruI0EfBqGbX5kA-PrVPKFeTGHUr18Gw1klJENjiLB0l4wopttTS0OcdoCDIzltjcJcMXJoXk2IjBBG5RvPPxF8aUZ5tSS3Zcfa9rf__v5g9EMaQM6G9oZ9R18I9-3N0gvFSGAjyQwLjOF677P0_qVRWsZs9E00F9l2U8fD9Y6FBF1bIH1Msj-FC93vq03gXkrwpEjf3xAvFGE9v99Pwgnp_ojDYOx0oRAo_Q'
    );
    xhr.onload = function (e) {
        console.log(this.response);
        console.log(this.status);
        if (this.status <= 201) {
            const data = JSON.parse(this.response);
            chrome.tabs.update({url: data.webUrl});
        } else {
          alert(this.response);
        }
    };
    xhr.send(stream);
}

function GetPdfStreamForLocal(streamResponse, streamInfo) {
    streamResponse.read().then(function (val) {
        OnGetStreamData(val.value, streamInfo);
    });
}

function ConvertOnlineDocToPDFAndOpen(streamInfo) {
    $(function () {
        var link =
            'https://' +
            GetURLPrefixForMimeType(streamInfo.mimeType) +
            '.edog.officeapps.live.com/document/export/pdf?url=' +
            streamInfo.originalUrl +
            '&input=' +
            GetUrlExtension(streamInfo.originalUrl);

        var xhr = new XMLHttpRequest();
        xhr.open('GET', link, true);
        xhr.responseType = 'blob';
        xhr.setRequestHeader(
            'X-ClientCorrelationId',
            '41b9f6c7-ea85-4859-9a97-be4628897113'
        );
        xhr.setRequestHeader('X-PassThroughDownloadHeaders', '');
        xhr.setRequestHeader('X-ClientName', 'EdgeTeam');
        //xhr.setRequestHeader("Ocp-Apim-Subscription-Key","34cd9e8623cc454a9333f497f882b3ad");

        xhr.onload = function (e) {
            if (this.status == 200) {
                var url = window.URL.createObjectURL(
                    new Blob([this.response], { type: 'application/pdf' })
                );

                document.getElementById('pdf-content').innerHTML =
                    '<iframe src="' +
                    url +
                    '" width="100%" height="100%"></iframe>';
            } else {
                this.response.text().then(function (str) {
                    document.getElementById('pdf-content-message').innerHTML =
                        '<div>Failed to load document: ' + str + ' :(</div>';
                    document.getElementById('pdf-content-message').innerHTML +=
                        '<div>Retriable = ' +
                        xhr.getResponseHeader('X-IsRetriable') +
                        '</div>';
                    document.getElementById('pdf-content-message').innerHTML +=
                        '<div>Response code = ' + xhr.status + '</div>';
                    alert('Failed to load document: ' + str);
                });
            }
        };
        xhr.send();
    });
}

function GetToolbarForMimeType(type) {
    switch (GetDocumentTypeHadler(type)) {
        case 'ms-word':
            return '#2C579A';
        case 'ms-powerpoint':
            return '#B8472A';
        case 'ms-excel':
            return '#207346';
    }
}

function GetAppTitleForMimeType(type) {
    switch (GetDocumentTypeHadler(type)) {
        case 'ms-word':
            return 'Word';
        case 'ms-powerpoint':
            return 'PowerPoint';
        case 'ms-excel':
            return 'Excel';
    }
}

function SetupToolbarAndDocTitle(streamInfo) {
    document.getElementById(
        'toolbar'
    ).style.backgroundColor = GetToolbarForMimeType(streamInfo.mimeType);
    document.getElementById('app-title').innerHTML = GetAppTitleForMimeType(
        streamInfo.mimeType
    );
    // Get the file name
    const fileName = decodeURI(
        streamInfo.originalUrl.split('/').pop().split('#')[0].split('?')[0]
    );
    document.getElementById('file-name').innerHTML = fileName + ' (Read-Only)';
    document.title = fileName;

    document.getElementById('edit-btn').innerHTML =
        'Edit in ' + GetAppTitleForMimeType(streamInfo.mimeType);
    document.getElementById('edit-btn').href =
        GetDocumentTypeHadler(streamInfo.mimeType) +
        ':ofe|u|' +
        streamInfo.originalUrl;

    document.getElementById('save').onclick = function () {
        executeSaveAs(
            decodeURI(
                streamInfo.originalUrl
                    .split('/')
                    .pop()
                    .split('#')[0]
                    .split('?')[0]
            )
        );
    };
}

let mimeType_ = '';

function IsWebURL(ulr_str) {
    return ulr_str.indexOf('http') == 0;
}

browser_api.then(function (browserApi) {
    if (!IsWebURL(browserApi.streamInfo_.originalUrl)) {
        fetch(browserApi.streamInfo_.streamUrl).then(function (e) {
            GetPdfStreamForLocal(e.body.getReader(), browserApi.streamInfo_);
        });
        return;
    }

    if (isAlreadyRedirected(browserApi.streamInfo_.originalUrl)) {
        chrome.downloads.download(
            {
                url: browserApi.streamInfo_.originalUrl
            },
            function (downloadId) {
                chrome.tabs.remove(browserApi.streamInfo_.tabId);
            }
        );
        return;
    }

    mimeType_ = browserApi.streamInfo_.mimeType;
    browserApi.streamInfo_.originalUrl = addRedirectedQueryParam(
        browserApi.streamInfo_.originalUrl
    );

    // Uncomment below lines for demo and replace the URL
    // document.getElementById('edit-btn').href = "http://www.bing.com";
    // document.getElementById('edit-btn').target = "_blank";

    // comment start for demo
    document.getElementById('edit-btn').href =
        GetDocumentTypeHadler(mimeType_) +
        ':ofe|u|' +
        browserApi.streamInfo_.originalUrl;
    // comment end
    document.getElementById('pdf-content').innerHTML =
        '<iframe allow="fullscreen" src="https://view.officeapps.live.com/op/view.aspx?src=' +
        browserApi.streamInfo_.originalUrl +
        '" width="100%" height="100%"></iframe>';
    const fileName = decodeURI(
        browserApi.streamInfo_.originalUrl
            .split('/')
            .pop()
            .split('#')[0]
            .split('?')[0]
    );
    document.title = fileName;
});

function isAlreadyRedirected(originalUrl) {
    if (originalUrl.indexOf('?') >= 0) {
        var queryParams = originalUrl.split('?')[1];
        return queryParams.indexOf('edgeRedirected') != -1;
    }

    return false;
}

function addRedirectedQueryParam(originalUrl) {
    if (originalUrl.indexOf('?') >= 0) {
        return originalUrl + '&edgeRedirected';
    }

    return originalUrl + '?edgeRedirected';
}

function executeSaveAs(fileName) {
    chrome.fileSystem.chooseEntry(
        {
            type: 'saveFile',
            suggestedName: fileName,
            // Saving the file with .pdf extension
            accepts: [{ extensions: [fileName.split('.').pop()] }]
        },
        writeUsingEntry
    );
}

const writeUsingEntry = (entry) => {
    if (chrome.runtime.lastError) {
        if (chrome.runtime.lastError.message !== 'User cancelled') {
            console.log(
                'chrome.fileSystem.chooseEntry failed: ' +
                    chrome.runtime.lastError.message
            );
        }
        return;
    }
    entry.createWriter((writer) => {
        writer.onwriteend = (event) => {
            // Return early in case error has occurred, without trying to
            // truncate the file. |onerror| is still called after returning.
            if (event.currentTarget && event.currentTarget.error) {
                return;
            }
            // |writer.length| is the length of the file content,
            // |event.currentTarget.position| is the seek position after
            // write (which for non error case is same as data length).
            // Truncate is called when |writer.length| is not same as
            // current seek position.
            if (writer.length !== event.currentTarget.position) {
                event.currentTarget.truncate(event.currentTarget.position);
                return;
            }
            chrome.fileSystem.getDisplayPath(entry, function (path) {
                promiseResolver.resolve({ status: 'Saved', path, saveInPlace });
            });
        };
        writer.onerror = (event) => {};
        writer.write(new Blob([result.dataToSave], { type: mimeType_ }));
    });
};
