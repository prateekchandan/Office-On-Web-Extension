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
  
    return new Promise(function(resolve, reject) {
      chrome.tabs.getZoomSettings(streamInfo.tabId, function(zoomSettings) {
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
  
    return new Promise(function(resolve, reject) {
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
      return Promise
          .all([lookupDefaultZoom(streamInfo), lookupInitialZoom(streamInfo)])
          .then(function(zoomFactors) {
            return new BrowserApi(
                streamInfo, zoomFactors[0], zoomFactors[1], zoomBehavior);
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
          'Viewer does not manage browser zoom.');
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
      if (!(this.zoomBehavior_ === BrowserApi.ZoomBehavior.MANAGE ||
            this.zoomBehavior_ === BrowserApi.ZoomBehavior.PROPAGATE_PARENT)) {
        return;
      }
  
      chrome.tabs.onZoomChange.addListener(info => {
        const zoomChangeInfo =
            /** @type {{tabId: number, newZoomFactor: number}} */ (info);
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
    return new Promise(function(resolve, reject) {
             chrome.mimeHandlerPrivate.getStreamInfo(resolve);
           })
        .then(function(streamInfo) {
          const promises = [];
          let zoomBehavior = BrowserApi.ZoomBehavior.NONE;
          if (streamInfo.tabId !== -1) {
            zoomBehavior = streamInfo.embedded ?
                BrowserApi.ZoomBehavior.PROPAGATE_PARENT :
                BrowserApi.ZoomBehavior.MANAGE;
            promises.push(new Promise(function(resolve) {
                            chrome.tabs.get(streamInfo.tabId, resolve);
                          }).then(function(tab) {
              if (tab) {
                streamInfo.tabUrl = tab.url;
              }
            }));
          }
          if (zoomBehavior === BrowserApi.ZoomBehavior.MANAGE) {
            promises.push(new Promise(function(resolve) {
              chrome.tabs.setZoomSettings(
                  streamInfo.tabId, {mode: 'manual', scope: 'per-tab'}, resolve);
            }));
          }
          return Promise.all(promises).then(function() {
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
      tabId: -1,
    };
    return new Promise(function(resolve, reject) {
             if (!chrome.tabs) {
               resolve();
               return;
             }
             chrome.tabs.getCurrent(function(tab) {
               streamInfo.tabId = tab.id;
               streamInfo.tabUrl = tab.url;
               resolve();
             });
           })
        .then(function() {
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

// function ReadAllData(responseBodyReader) {
//     document.getElementById("test").innerHTML += "<div> Contents: </div>";
//     function Read() {
//         responseBodyReader.read().then(function(val) {
//             temp = Decodeuint8arr(val.value)
//             data += temp
//             document.getElementById("test").innerHTML += "<div>"+temp+"</div>";
//             if(val.done) {
//                 console.log("Reading complete" + data.length)
//             } else {
//                 console.log("Reading more" + data.length)
//                 Read()
//             }
//         })
//     }

//     Read();
// }

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

function GetPdfStream(streamInfo) {
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
                    document.getElementById('pdf-content').innerHTML =
                        '<div>Failed to load document: ' + str + ' :(</div>';
                    document.getElementById('pdf-content').innerHTML +=
                        '<div>Retriable = ' +
                        xhr.getResponseHeader('X-IsRetriable') +
                        '</div>';
                    document.getElementById('pdf-content').innerHTML +=
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

function SetupToolbar(streamInfo) {
    document.getElementById(
        'toolbar'
    ).style.backgroundColor = GetToolbarForMimeType(streamInfo.mimeType);
    document.getElementById('app-title').innerHTML = GetAppTitleForMimeType(
        streamInfo.mimeType
    );
    // Get the file name
    document.getElementById('file-name').innerHTML =
        decodeURI(
            streamInfo.originalUrl.split('/').pop().split('#')[0].split('?')[0]
        ) + ' (Read-Only)';

    document.getElementById('edit-btn').innerHTML =
        'Edit in ' + GetAppTitleForMimeType(streamInfo.mimeType);
    document.getElementById('edit-btn').href =
        GetDocumentTypeHadler(streamInfo.mimeType) +
        ':ofe|u|' +
        streamInfo.originalUrl;
}

browser_api.then(function (browserApi) {
    SetupToolbar(browserApi.streamInfo_);
    GetPdfStream(browserApi.streamInfo_);
});
