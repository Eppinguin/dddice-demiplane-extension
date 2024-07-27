/** @format */
import browser from 'webextension-polyfill';
import createLogger from './log';
import { getStorage } from './storage';
import { IRoll, ThreeDDiceRollEvent, ThreeDDice, ITheme, ThreeDDiceAPI } from 'dddice-js';
import imageLogo from 'url:./assets/dddice-32x32.png';
import notify from './utils/notify';
import { Notify } from 'notiflix/build/notiflix-notify-aio';

Notify.init({
  useIcon: false,
  fontSize: '16px',
  timeout: 10000,
  clickToClose: true,
});

const log = createLogger('demiplane');
log.info('DDDICE Demiplane');
console.log('DDDICE Demiplane');

const FADE_TIMEOUT = 100;
let dddice: ThreeDDice;
let canvasElement: HTMLCanvasElement;
const DEFAULT_THEME = 'dddice-bees';

function injectScript(filePath: string) {
  const script = document.createElement('script');
  script.src = browser.runtime.getURL(filePath);
  script.onload = function() {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);
}
injectScript('up_/demiplane_inject.js');

window.addEventListener('diceRollRequest', (event: CustomEvent) => {
  const responseData = event.detail;
  console.log('Dice roll request:', responseData);
  if (responseData && responseData.url) {
    sendRollRequest(rollToDDDice(responseData.url.split('dice-roll?roll=')[1]));
  } else {
    console.error('Received null or invalid responseData:', responseData);
  }
});

function rollToDDDice(roll: string) {
  // NOTE: There is no way to tell if the roll was made with advantage or disadvantage
  const themeFear = 'star-teller-dice-lhwstfnd';
  const themeHope = 'greed-n\'-riches-lm86crmx';
  // Decode the URL-encoded string
  const decodedRoll = decodeURIComponent(roll);
  console.log('Decoded Roll:', decodedRoll);

  // Regular expression to match dice rolls and modifiers
  const diceRegex = /(\d+)d(\d+)/g;
  const modifierRegex = /-?\d+$/g;

  // Extract dice rolls
  const diceMatches = [...decodedRoll.matchAll(diceRegex)];
  const diceDetails = diceMatches.flatMap(match => {
    const numDice = parseInt(match[1], 10);
    const diceSize = `d${match[2]}`;
    return Array(numDice).fill(null).map((_, index) => ({
      type: diceSize,
      theme: index % 2 === 0 ? themeHope : themeFear,
      label: index % 2 === 0 ? 'Hope' : 'Fear',
    }));
  });

  // Extract modifiers
  const modifierMatches = [...decodedRoll.matchAll(modifierRegex)];
  const modifiers = modifierMatches
    .map(match => ({
      type: 'mod',
      theme: themeHope, // or any other theme you prefer for modifiers
      value: parseInt(match[0], 10)
    }))
    .filter(modifier => modifier.value !== 0);
  // Combine dice details and modifiers, only adding modifiers if present
  return modifiers.length > 0 ? [...diceDetails, ...modifiers] : diceDetails;

}
function transformDiceData(diceArray) {
  if (!Array.isArray(diceArray)) {
    throw new TypeError('Expected an array of dice objects');
  }

  let total = 0;
  let crit = 0;
  const rawDiceParts = [];

  const diceGroups = diceArray.reduce((acc, dice) => {
    if (dice.type === 'mod') {
      total += dice.value;
      rawDiceParts.push({ type: 'operator', value: dice.value > 0 ? '+' : '-', annotation: '' });
      rawDiceParts.push({ type: 'constant', value: Math.abs(dice.value), annotation: '' });
    } else {
      total += dice.value;
      const key = `${dice.type}-${dice.theme}`;
      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key].push(dice);
    }
    return acc;
  }, {});

  for (const key in diceGroups) {
    const group = diceGroups[key];
    const diceType = group[0].type;
    const diceSize = parseInt(diceType.slice(1), 10);
    const numDice = group.length;
    const values = group.map(d => d.value);
    const groupTotal = values.reduce((sum, val) => sum + val, 0);
    const text = `${numDice}${diceType} (${values.join(', ')}) `;
    rawDiceParts.push({
      type: 'dice',
      dice: group.map(d => ({
        type: 'single_dice',
        value: d.value,
        size: diceSize,
        is_kept: true,
        rolls: [d.value],
        exploded: false,
        imploded: false
      })),
      annotation: '',
      value: groupTotal,
      is_crit: 0,
      num_kept: numDice,
      text,
      num_dice: numDice,
      dice_size: diceSize,
      operators: []
    });
    rawDiceParts.push({ type: 'operator', value: '+', annotation: '' });
  }

  // Remove the last operator
  if (rawDiceParts.length > 0 && rawDiceParts[rawDiceParts.length - 1].type === 'operator') {
    rawDiceParts.pop();
  }

  return {
    total,
    crit,
    raw_dice: {
      parts: rawDiceParts
    },
    error: ''
  };
}

 // TODO: Add Dice from URL to send Roll Request, than await response and update chat
function updateChat(roll: IRoll) {
  // console.log("updateChat:", roll.values);
  console.log(console.log("Dice Data:", transformDiceData(roll.values)));
  const requestEvent = new CustomEvent('diceRollResponse', {
    detail: {
      responseText: JSON.stringify(transformDiceData(roll.values))
      // responseText: JSON.stringify({
      //   "total": 21,
      //   "crit": 0,
      //   "raw_dice": {
      //     "parts": [
      //       {
      //         "type": "dice",
      //         "dice": [
      //           { "type": "single_dice", "value": 11, "size": 12, "is_kept": true, "rolls": [4], "exploded": false, "imploded": false },
      //           { "type": "single_dice", "value": 10, "size": 12, "is_kept": true, "rolls": [12], "exploded": false, "imploded": false }
      //         ],
      //         "annotation": "",
      //         "value": 16,
      //         "is_crit": 0,
      //         "num_kept": 2,
      //         "text": "2d12 (4, 12) ",
      //         "num_dice": 2,
      //         "dice_size": 12,
      //         "operators": []
      //       },
      //       { "type": "operator", "value": "+", "annotation": "" },
      //       { "type": "constant", "value": 0, "annotation": "" }
      //     ]
      //   },
      //   "error": ""
      // })
    }
  });
  window.dispatchEvent(requestEvent);
}

async function sendRollRequest(roll) {
  // Handle the response data as needed
  const [room, _theme] = await Promise.all([getStorage('room'), getStorage('theme')]);

  if (!dddice?.api) {
    notify(
      `dddice extension hasn't been set up yet. Please open the the extension pop up via the extensions menu`,
    );
  } else if (!room?.slug) {
    notify(
      'No dddice room has been selected. Please open the dddice extension pop up and select a room to roll in',
    );
  } else {
    try {
      await dddice.api.room.updateRolls(room.slug, { is_cleared: true });
      await dddice.api.roll.create(roll, {
        external_id: `dndbCharacterId:${"characterId"}`,
      });
    } catch (e) {
      console.error(e);
      notify(`${e.response?.data?.data?.message ?? e}`);
    }
  }
}

async function initializeSDK() {
  return Promise.all([
    getStorage('apiKey'),
    getStorage('room'),
    getStorage('theme'),
    getStorage('render mode'),
  ]).then(async ([apiKey, room, theme, renderMode]) => {
    if (apiKey) {
      log.debug('initializeSDK', renderMode);
      if (dddice) {
        // clear the board
        if (canvasElement) canvasElement.remove();
        // disconnect from echo
        if (dddice.api?.connection) dddice.api.connection.disconnect();
        // stop the animation loop
        dddice.stop();
      }
      if (renderMode === undefined || renderMode) {
        canvasElement = document.createElement('canvas');
        canvasElement.id = 'dddice-canvas';
        canvasElement.style.top = '0px';
        canvasElement.style.position = 'fixed';
        canvasElement.style.pointerEvents = 'none';
        canvasElement.style.zIndex = '100000';
        canvasElement.style.opacity = '100';
        canvasElement.style.height = '100vh';
        canvasElement.style.width = '100vw';
        document.body.appendChild(canvasElement);
        try {
          dddice = new ThreeDDice().initialize(canvasElement, apiKey, undefined, 'Demiplane');
          dddice.on(ThreeDDiceRollEvent.RollFinished, (roll: IRoll) => updateChat(roll));
          dddice.start();
          if (room) {
            dddice.connect(room.slug);
          }
        } catch (e) {
          console.error(e);
          notify(`${e.response?.data?.data?.message ?? e}`);
        }
        if (theme) {
          preloadTheme(theme);
        }
      } else {
        try {
          dddice = new ThreeDDice();
          dddice.api = new ThreeDDiceAPI(apiKey, 'Demiplane');
          if (room) {
            dddice.api.connect(room.slug);
          }
        } catch (e) {
          console.error(e);
          notify(`${e.response?.data?.data?.message ?? e}`);
        }
        dddice.api.listen(ThreeDDiceRollEvent.RollCreated, (roll: IRoll) =>
          setTimeout(() => updateChat(roll), 1500),
        );
      }
    } else {
      log.debug('no api key');
    }
  });
}
// function updateChat(roll: IRoll) {}

function preloadTheme(theme: ITheme) {
  dddice.loadTheme(theme, true);
  dddice.loadThemeResources(theme.id, true);
}
initializeSDK();