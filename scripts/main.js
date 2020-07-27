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
data = ""

/**
 * Convert an Uint8Array into a string.
 *
 * @returns {String}
 */
function Decodeuint8arr(uint8array){
    return new TextDecoder("utf-8").decode(uint8array);
}

function ReadAllData(responseBodyReader) {
    document.getElementById("test").innerHTML += "<div> Contents: </div>";
    function Read() {
        responseBodyReader.read().then(function(val) {
            temp = Decodeuint8arr(val.value)
            data += temp
            document.getElementById("test").innerHTML += "<div>"+temp+"</div>";
            if(val.done) {
                console.log("Reading complete" + data.length)
            } else {
                console.log("Reading more" + data.length)
                Read()
            }
        })
    }

    Read();

    // base64 pdf encoded pdf stream.
    let pdfStream = "JVBERi0xLjcKJaDypPQKMSAwIG9iaiA8PAogIC9UeXBlIC9DYXRhbG9nCiAgL1BhZ2VzIDIgMCBSCj4+CmVuZG9iagoyIDAgb2JqIDw8CiAgL1R5cGUgL1BhZ2VzCiAgL01lZGlhQm94IFsgMCAwIDIwMCAyMDAgXQogIC9Db3VudCAxCiAgL0tpZHMgWyAzIDAgUiBdCj4+CmVuZG9iagozIDAgb2JqIDw8CiAgL1R5cGUgL1BhZ2UKICAvUGFyZW50IDIgMCBSCiAgL1Jlc291cmNlcyA8PAogICAgL0ZvbnQgPDwKICAgICAgL0YxIDQgMCBSCiAgICAgIC9GMiA1IDAgUgogICAgPj4KICA+PgogIC9Db250ZW50cyA2IDAgUgo+PgplbmRvYmoKNCAwIG9iaiA8PAogIC9UeXBlIC9Gb250CiAgL1N1YnR5cGUgL1R5cGUxCiAgL0Jhc2VGb250IC9UaW1lcy1Sb21hbgo+PgplbmRvYmoKNSAwIG9iaiA8PAogIC9UeXBlIC9Gb250CiAgL1N1YnR5cGUgL1R5cGUxCiAgL0Jhc2VGb250IC9IZWx2ZXRpY2EKPj4KZW5kb2JqCjYgMCBvYmogPDwKPj4Kc3RyZWFtCkJUCjIwIDUwIFRkCi9GMSAxMiBUZgooSGVsbG8sIHdvcmxkISkgVGoKMCA1MCBUZAovRjIgMTYgVGYKKEdvb2RieWUsIHdvcmxkISkgVGoKRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNwowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA2OCAwMDAwMCBuIAowMDAwMDAwMTYxIDAwMDAwIG4gCjAwMDAwMDAzMDMgMDAwMDAgbiAKMDAwMDAwMDM4MSAwMDAwMCBuIAowMDAwMDAwNDU3IDAwMDAwIG4gCnRyYWlsZXI8PCAvUm9vdCAxIDAgUiAvU2l6ZSA3ID4+CnN0YXJ0eHJlZgo1NzgKJSVFT0YK";
    // Creating an iframe to render PDF.
    document.getElementById("test").innerHTML += "<iframe width='100%' height='100%' src='data:application/pdf;base64, "
                                                + encodeURI(pdfStream) + "'></iframe>";

}

function GetDocumentTypeHadler(mimeType) {
    switch (mimeType) {
        case "application/msword":
        case "application/vnd.ms-word":
        case "application/vnd.msword":
        case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        case "application/vnd.wordprocessing-openxml":
        case "application/vnd.ces-quickword":
        case "application/vnd.ms-word.document.macroEnabled.12":
        case "application/vnd.ms-word.document.macroenabled.12":
        case "application/vnd.ms-word.document.12":
            return "ms-word";
        case "application/mspowerpoint":
        case "application/vnd.ms-powerpoint":
        case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
        case "application/vnd.ces-quickpoint":
        case "application/vnd.presentation-openxml":
        case "application/vnd.presentation-openxmlm":
        case "application/vnd.ms-powerpoint.presentation.macroEnabled.12":
        case "application/vnd.ms-powerpoint.presentation.macroenabled.12":
            return "ms-powerpoint";
        case "application/msexcel":
        case "application/vnd.ms-excel":
        case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
        case "application/vnd.ces-quicksheet":
        case "application/vnd.spreadsheet-openxml":
        case "application/vnd.ms-excel.sheet.macroEnabled.12":
        case "application/vnd.ms-excel.sheet.macroenabled.12":
        case "text/csv":
            return "ms-excel";
    }
}

browser_api.then(function(browserApi) {
    document.getElementById("test").innerHTML += "<div>URL : " + browserApi.streamInfo_.originalUrl + "</div>";
    document.getElementById("test").innerHTML += "<div>MimeType : " + browserApi.streamInfo_.mimeType + "</div>";
    document.getElementById("test").innerHTML += "<div>StreamURL : " + browserApi.streamInfo_.streamUrl + "</div>";
    document.getElementById("test").innerHTML += 
        "<a href='"+GetDocumentTypeHadler(browserApi.streamInfo_.mimeType)+":ofe|u|"+browserApi.streamInfo_.originalUrl+"'>Edit in "+GetDocumentTypeHadler(browserApi.streamInfo_.mimeType)+"</div>";

    fetch(browserApi.streamInfo_.streamUrl ).then(function(e) {
        ReadAllData(e.body.getReader());
    })

    console.log(browserApi.streamInfo_);
});


  