import { MSG } from '../shared/constants.js';
import { getSelection } from './selection-handler.js';
import { FloatingPanel } from './floating-panel.js';

const panel = new FloatingPanel();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case MSG.GET_SELECTION: {
      const result = getSelection();
      sendResponse(result);
      break;
    }
    case MSG.TRANSLATE_START: {
      panel.show(message.payload.position);
      break;
    }
    case MSG.STREAM_CHUNK: {
      panel.appendChunk(message.payload.chunk);
      break;
    }
    case MSG.TRANSLATE_DONE: {
      panel.done();
      break;
    }
    case MSG.TRANSLATE_ERROR: {
      panel.showError(message.payload.message);
      break;
    }
  }
  return false;
});
