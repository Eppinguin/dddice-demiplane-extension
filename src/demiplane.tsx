/** @format */
import createLogger from './log';
import { getStorage, setStorage } from './storage';
import { IRoll, ThreeDDiceRollEvent, ThreeDDice, ITheme, ThreeDDiceAPI, IUser } from 'dddice-js';
import notify from './utils/notify';
import { Notify } from 'notiflix/build/notiflix-notify-aio';

const log = createLogger('demiplane');
log.debug('dddice-demiplane script starting...');
log.info('DDDICE Demiplane');

Notify.init({
  useIcon: false,
  fontSize: '16px',
  timeout: 10000,
  clickToClose: true,
});

let dddice: ThreeDDice;
let canvasElement: HTMLCanvasElement;
let user: IUser;
let isInitialized = false; // Track initialization state
let watchingStorage = false; // Track if we're already watching storage

interface DiceRoll {
  type: string;
  name: string;
  result: {
    dice: Array<{
      id: number;
      die: string;
      value: number;
      maxValue: number;
      slug: string;
      is_kept: boolean;
      originalValue?: number;
      config: {
        priority: number;
        dieSlug: string;
        slug: string;
        image: string;
        rerollable: boolean;
        name: string;
        isNegative?: boolean;
      };
    }>;
    total: number;
    maxTotal: number;
    crit: number;
    status: {
      priority: number;
      slug: string;
      label: string;
      conditions: Array<any>;
    };
  };
  dice: Array<{
    slug: string;
    die: string;
    label: string;
    image: string;
    pooledImage: string;
  }>;
  roll: string;
  modifiersParsed: Array<{
    value: number | string;
    purpose: string;
    rollString: string;
  }>;
  rerolled: boolean;
}

function getRollNameFromData(roll: DiceRoll): string {
  const purposeModifier = roll.modifiersParsed.find(m => m.purpose === 'misc');
  const nameModifier = roll.modifiersParsed[2]; // Based on the example, this seems to be where the ability/spell name is

  if (purposeModifier?.value && nameModifier?.value) {
    return `${purposeModifier.value}: ${nameModifier.value}`;
  }
  return roll.name;
}

function getTypeResultFromData(roll: DiceRoll): string {
  if (roll.result.status.slug === 'critical-success') {
    return ' Critical Success!';
  }

  const hasFear = roll.dice.some(d => d.slug === 'fear');
  const hasHope = roll.dice.some(d => d.slug === 'hope');

  if (hasFear) return ' with Fear';
  if (hasHope) return ' with Hope';
  return '';
}

function processRoll(roll: DiceRoll): void {
  log.debug('Processing roll:', {
    name: roll.name,
    dice: roll.dice.map(d => d.die),
    modifiers: roll.modifiersParsed,
    result: roll.result,
  });

  const diceArray: Array<{
    type: string;
    value: number;
    theme: string | undefined;
    label?: string;
  }> = [];

  roll.result.dice.forEach(die => {
    const value = die.config.isNegative ? -die.value : die.value;
    const label = die.config.name;

    diceArray.push({
      type: die.value > 0 ? die.die : 'mod',
      value,
      theme: undefined, // Will be set in sendRollRequest based on die type
      label,
    });
  });

  // Add static modifier if present
  const modifierValue = roll.modifiersParsed.find(m => m.purpose === 'add')?.value;
  if (typeof modifierValue === 'number' && modifierValue !== 0) {
    diceArray.push({
      type: 'mod',
      value: modifierValue,
      theme: undefined,
    });
  }

  log.debug('Prepared dice array for 3D roll:', diceArray);
  sendRollRequest(diceArray, roll);
}

async function watchLocalStorage(): Promise<void> {
  // Get character UUID from URL
  const match = window.location.pathname.match(/\/nexus\/[^/]+\/character-sheet\/([^/]+)/);
  if (!match) {
    log.debug('No character UUID found in URL');
    return;
  }

  // If we're already watching storage for this session, don't set up another watcher
  if (watchingStorage) {
    log.debug('Already watching localStorage');
    return;
  }

  const characterUuid = match[1];
  const storageKey = `${characterUuid}-dice-history`;
  log.debug('Watching localStorage key:', storageKey);

  // Initialize lastRolls with current state to prevent rolling on page load
  const historyString = localStorage.getItem(storageKey);
  let lastRolls: DiceRoll[] | null = historyString ? JSON.parse(historyString) : null;

  const checkForNewRolls = async () => {
    const historyString = localStorage.getItem(storageKey);
    if (!historyString) return;

    try {
      const currentRolls: DiceRoll[] = JSON.parse(historyString);

      if (
        !lastRolls ||
        (currentRolls[0] && JSON.stringify(currentRolls[0]) !== JSON.stringify(lastRolls[0]))
      ) {
        // Process only the newest roll
        const newestRoll = currentRolls[0];
        if (newestRoll) {
          log.debug(
            'Processing roll:',
            newestRoll.name,
            'with dice:',
            newestRoll.dice.map(d => d.die).join(', '),
          );
          processRoll(newestRoll);
        }
        lastRolls = currentRolls;
      }
    } catch (e) {
      log.debug('Error parsing dice history:', e);
    }
  };

  // Set up the interval to watch for future changes
  setInterval(checkForNewRolls, 1000);
  watchingStorage = true; // Mark that we're watching storage
}

async function sendRollRequest(
  roll: Array<{ type: string; value: number; theme: string | undefined; label?: string }>,
  originalRoll: DiceRoll,
): Promise<void> {
  const [room, theme, hopeTheme, fearTheme] = await Promise.all([
    getStorage('room'),
    getStorage('theme'),
    getStorage('hopeTheme'),
    getStorage('fearTheme'),
  ]);

  if (!dddice?.api) {
    notify(
      `dddice extension hasn't been set up yet. Please open the extension pop up via the extensions menu`,
    );
    return;
  }

  if (!room?.slug) {
    notify(
      'No dddice room has been selected. Please open the dddice extension pop up and select a room to roll in',
    );
    return;
  }

  // Wait for initialization using public methods
  if (dddice) {
    log.debug('Waiting for 3D engine to initialize...');
    try {
      await new Promise<void>((resolve, reject) => {
        let attempts = 0;
        const maxAttempts = 50; // 5 seconds total
        const checkReady = () => {
          // Use a try-catch to check if the engine is ready
          try {
            // Attempt to access a method that requires initialization
            dddice.clear();
            resolve();
          } catch (e) {
            if (attempts >= maxAttempts) {
              reject(new Error('3D engine initialization timeout'));
            } else {
              attempts++;
              setTimeout(checkReady, 100);
            }
          }
        };
        checkReady();
      });
    } catch (e) {
      log.error('Failed to initialize 3D engine:', e);
      notify('Failed to initialize 3D engine. Please refresh the page.');
      return;
    }
  }

  try {
    log.debug('Sending roll:', roll);
    // Assign themes based on die type
    roll.forEach(die => {
      if (die.label === 'Hope') {
        die.theme = hopeTheme?.id;
      } else if (die.label === 'Fear') {
        die.theme = fearTheme?.id;
      } else {
        die.theme = theme?.id;
      }
    });

    if (!theme?.id) {
      log.debug('No theme selected, using default');
    }

    const label = getRollNameFromData(originalRoll) + getTypeResultFromData(originalRoll);
    await dddice.api.roll.create(roll, { label: label });
  } catch (e: any) {
    log.error('Roll creation failed:', e);
    notify(
      `Failed to create roll: ${e.response?.data?.data?.message ?? e.message ?? 'Unknown error'}`,
    );
  }
}

async function initializeSDK(): Promise<void> {
  const [apiKey, room, theme, renderMode] = await Promise.all([
    getStorage('apiKey'),
    getStorage('room'),
    getStorage('theme'),
    getStorage('render mode'),
  ]);

  if (!apiKey) {
    log.debug('no api key');
    return;
  }

  log.debug('initializeSDK', renderMode);
  if (dddice) {
    if (canvasElement) canvasElement.remove();
    if (dddice.api?.disconnect) dddice.api.disconnect();
    dddice.stop();
  }

  try {
    if (renderMode === undefined || renderMode) {
      canvasElement = document.createElement('canvas');
      canvasElement.id = 'dddice-canvas';
      canvasElement.style.cssText =
        'top:0px; position:fixed; pointer-events:none; z-index:100000; opacity:100; height:100vh; width:100vw;';
      document.body.appendChild(canvasElement);

      dddice = new ThreeDDice().initialize(canvasElement, apiKey, undefined, 'Demiplane');
      dddice.on(ThreeDDiceRollEvent.RollFinished, (roll: IRoll) => notifyRollFinished(roll));
      dddice.start();
      if (room?.slug) {
        dddice.connect(room.slug);
      }
    } else {
      dddice = new ThreeDDice();
      dddice.api = new ThreeDDiceAPI(apiKey, 'Demiplane');
      if (room?.slug) {
        dddice.api.connect(room.slug);
      }
      dddice.api?.listen(ThreeDDiceRollEvent.RollCreated, (roll: IRoll) =>
        setTimeout(() => notifyRollCreated(roll), 1500),
      );
    }
    if (theme) preloadTheme(theme);

    // Mark initialization as complete
    isInitialized = true;
    // Store initialization state in extension storage
    setStorage({ demiplane_initialized: true });

    // Start watching for dice rolls
    log.debug('Starting localStorage watch from initializeSDK');
    watchLocalStorage();
  } catch (e: any) {
    log.debug(e);
    notify(`${e.response?.data?.data?.message ?? e}`);
  }
}

function notifyRollFinished(roll: IRoll) {
  Notify.success(generateNotificationMessage(roll));
}

function notifyRollCreated(roll: IRoll) {
  Notify.info(generateNotificationMessage(roll));
}

function generateNotificationMessage(roll: IRoll) {
  const roller = roll.room.participants.find(
    participant => participant.user.uuid === roll.user.uuid,
  );

  return `${roller?.username ?? 'Unknown'}: ${roll.equation} = ${
    typeof roll.total_value === 'object' ? '⚠' : roll.total_value
  }`;
}

function preloadTheme(theme: ITheme): Promise<void> {
  if (!theme || !dddice) {
    log.debug('Cannot preload theme: missing theme or dddice instance');
    return Promise.resolve();
  }

  try {
    dddice.loadTheme(theme, true);
    // Just execute loadThemeResources and return void
    dddice.loadThemeResources(theme.id, true);
    return Promise.resolve();
  } catch (e) {
    log.debug('Error preloading theme:', e);
    return Promise.reject(e);
  }
}

async function init() {
  if (!/^\/(nexus\/daggerheart\/character-sheet\/.+)/.test(window.location.pathname)) {
    log.debug('uninit: not on a character sheet page');
    const currentCanvas = document.getElementById('dddice-canvas');
    if (currentCanvas) {
      currentCanvas.remove();
      dddice = undefined as unknown as ThreeDDice;
    }
    return;
  }
  log.debug('init: on character sheet page');

  // Check if we're already initialized with the API ready
  if (!isInitialized && !dddice?.api) {
    // Check if previously initialized in storage
    const initialized = await getStorage('demiplane_initialized');
    const apiKey = await getStorage('apiKey');

    log.debug('Checking initialization state:', { initialized, apiKeyExists: !!apiKey });

    if (apiKey) {
      // If API key exists, initialize the SDK
      await initializeSDK();
    }
  } else {
    log.debug('Already initialized, updating state if needed');
    // We're already initialized, just make sure we're watching localStorage
    if (!watchingStorage) {
      log.debug('Starting localStorage watch for dice rolls');
      watchLocalStorage();
    }

    // Update character name if needed
    const room = await getStorage('room');
    if (!user) {
      try {
        user = (await dddice?.api?.user.get())?.data;
      } catch (e) {
        log.debug('Failed to get user', e);
      }
    }

    const characterName = document.querySelector<HTMLElement>(
      '.MuiGrid-root.MuiGrid-item.text-block.character-name.css-1ipveys .text-block__text.MuiBox-root.css-1dyfylb',
    )?.textContent;

    if (room && user && characterName) {
      const userParticipant = room.participants.find(
        ({ user: { uuid: participantUuid } }) => participantUuid === user.uuid,
      );

      if (userParticipant && characterName && userParticipant.username !== characterName) {
        userParticipant.username = characterName;
        setStorage({ room });
        await dddice?.api?.room.updateParticipant(room.slug, userParticipant.id, {
          username: characterName,
        });
      }
    }
    if (dddice?.canvas) dddice.resize(window.innerWidth, window.innerHeight);
  }
}

document.addEventListener('click', () => {
  if (dddice && !dddice?.isDiceThrowing) dddice.clear();
});

// @ts-ignore
chrome.runtime.onMessage.addListener(function (message) {
  switch (message.type) {
    case 'reloadDiceEngine':
      initializeSDK();
      break;
    case 'preloadTheme':
      preloadTheme(message.theme);
      break;
  }
});

// Initialize on page load and resize
window.addEventListener('load', () => init());
window.addEventListener('resize', () => init());

// Also initialize when the script first runs
init();

// Add listener for URL changes (for single-page app navigation)
let lastUrl = window.location.href;
new MutationObserver(() => {
  const currentUrl = window.location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    log.debug('URL changed, reinitializing extension');
    init();
  }
}).observe(document, { subtree: true, childList: true });
