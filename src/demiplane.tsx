/** @format */
import createLogger from './log';
import { getStorage, setStorage } from './storage';
import { IRoll, ThreeDDiceRollEvent, ThreeDDice, ITheme, ThreeDDiceAPI, IUser } from 'dddice-js';
import notify from './utils/notify';
import { Notify } from 'notiflix/build/notiflix-notify-aio';

const log = createLogger('demiplane');
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

// Game system detection and configuration
enum GameSystem {
  DAGGERHEART = 'daggerheart',
  COSMERERPG = 'cosmererpg',
  UNKNOWN = 'unknown',
}

interface GameConfig {
  pathRegex: RegExp;
  storageKeyPattern: string;
  getRollName: (roll: DiceRoll) => string;
  getTypeResult: (roll: DiceRoll) => string;
  processDice: (roll: DiceRoll) =>
    | Array<{
        type: string;
        value: number;
        theme: string | undefined;
        label?: string;
        groupSlug?: string;
      }>
    | {
        dice: Array<{
          type: string;
          value: number;
          theme: string | undefined;
          label?: string;
          groupSlug?: string;
        }>;
        operator: object;
        plotDice?: {
          type: string;
          value: number;
          theme: string | undefined;
          label?: string;
          groupSlug?: string;
        };
      };
  getCharacterNameSelector?: string;
}

interface ModifierEntry {
  value: number | string;
  purpose: string;
  rollString: string;
}

interface DiceRoll {
  // Common properties
  name: string;
  type?: string;

  // Cosmere/Daggerheart specific properties
  dice?: Array<{
    slug: string;
    die: string;
    type?: string; // Add this for kh/kl support
    label: string;
    image: string;
    pooledImage: string;
  }>;
  roll?: string;
  modifiersParsed?: ModifierEntry[] | ModifierEntry[][] | ModifierEntry;
  rerolled?: boolean;

  // Cosmere specific
  results?: Array<{
    dice: Array<{
      originalValue: any;
      id: number;
      die: string;
      value: number;
      maxValue: number;
      slug: string;
      is_kept: boolean;
      groupSlug?: string;
      config: {
        priority: number;
        dieSlug: string;
        slug: string;
        image: string;
        rerollable: boolean;
        name: string;
        isNegative?: boolean;
        overrideValue?: number;
      };
    }>;
    total: number;
    maxTotal: number;
    crit: number;
    status?: {
      priority: number;
      slug: string;
      label: string;
      conditions: Array<any>;
    };
  }>;

  origin?: string;

  // Result can have different structures
  result: {
    // Daggerheart/Cosmere structure
    dice?: Array<{
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
        overrideValue?: number;
      };
    }>;

    // Common properties
    total: number;
    maxTotal?: number;
    crit?: number;
    status?: {
      priority: number;
      slug: string;
      label: string;
      conditions: Array<any>;
    };

    raw_dice?: {
      parts: Array<{
        type: string;
        value: number;
        annotation?: string;
        is_crit?: number;
        text?: string;
        operators?: Array<any>;
        dice?: Array<{
          type: string;
          value: number;
          size: number;
          is_kept: boolean;
          rolls: Array<number>;
          exploded: boolean;
          imploded: boolean;
        }>;
        num_kept?: number;
        num_dice?: number;
        dice_size?: number;
      }>;
    };
    error?: string;
  };
}

const gameConfigs: Record<GameSystem, GameConfig> = {
  [GameSystem.DAGGERHEART]: {
    pathRegex: /^\/nexus\/daggerheart\/character-sheet\/([^/]+)/,
    storageKeyPattern: '{uuid}-dice-history',
    getRollName: roll => {
      if (!Array.isArray(roll.modifiersParsed)) {
        const mod = roll.modifiersParsed as ModifierEntry | undefined;
        if (mod?.purpose === 'misc') {
          const nameModifier = roll.modifiersParsed;
          if (nameModifier && typeof nameModifier === 'object' && 'value' in nameModifier) {
            return `${nameModifier.value}`;
          }
        }
      }
      return roll.name;
    },
    getTypeResult: roll => {
      if (roll?.result?.status?.slug === 'critical-success') {
        return ' Critical Success!';
      }
      if (roll?.result?.status?.slug === 'roll-with-hope') {
        return ' with Hope';
      }
      if (roll?.result?.status?.slug === 'roll-with-fear') {
        return ' with Fear';
      }
      return '';
    },
    processDice: roll => {
      const diceArray = [];

      roll.result.dice.forEach(die => {
        // const value = die.config.isNegative ? -die.value : die.value;
        const label = die.config.name;
        log.debug('Processing die:', die);

        diceArray.push({
          type: die.value > 0 ? die.die : 'mod',
          value: die.value,
          theme: undefined, // Will be set in sendRollRequest based on die type
          label,
        });
      });

      // Add static modifier if present
      if (roll.modifiersParsed) {
        if (Array.isArray(roll.modifiersParsed)) {
          const modifiers = roll.modifiersParsed as ModifierEntry[];
          const addModifier = modifiers.find(m => m.purpose === 'add');
          if (addModifier && typeof addModifier.value === 'number' && addModifier.value !== 0) {
            diceArray.push({
              type: 'mod',
              value: addModifier.value,
              theme: undefined,
            });
          }
        } else if (
          !Array.isArray(roll.modifiersParsed) &&
          typeof roll.modifiersParsed === 'object'
        ) {
          const mod = roll.modifiersParsed as ModifierEntry;
          if (mod.purpose === 'add' && typeof mod.value === 'number' && mod.value !== 0) {
            diceArray.push({
              type: 'mod',
              value: mod.value,
              theme: undefined,
            });
          }
        }
      }

      return diceArray;
    },
    getCharacterNameSelector: '.character-name',
  },
  [GameSystem.COSMERERPG]: {
    pathRegex: /^\/nexus\/cosmererpg\/character-sheet\/([^/]+)/,
    storageKeyPattern: '{uuid}-dice-history',
    getRollName: roll => {
      if (Array.isArray(roll.modifiersParsed)) {
        const firstGroup = roll.modifiersParsed[0];
        if (Array.isArray(firstGroup)) {
          const mods = firstGroup as ModifierEntry[];
          const purposeModifier = mods.find(m => m.purpose === 'misc');
          const nameModifier = mods.find(
            m => m.purpose === 'misc' && m.value !== purposeModifier?.value,
          );

          if (purposeModifier?.value && nameModifier?.value) {
            return `${purposeModifier.value}: ${nameModifier.value}`;
          }
        }
      }
      return roll.name;
    },
    getTypeResult: roll => {
      // First check for plot die in the dice array
      const plotDie = roll.dice?.find(d => d.slug === 'plot');

      // Look for plot die value in different possible locations
      let plotDieValue;

      // Check in roll.results first
      if (roll.results && roll.results.length > 0) {
        const plotDieResult = roll.results[0]?.dice.find(d => d.slug === 'plot');
        plotDieValue = plotDieResult?.originalValue || plotDieResult?.value;
      }

      // If not found, check in roll.result.dice
      if (!plotDieValue && roll.result.dice) {
        const plotDieResult = roll.result.dice.find(d => d.slug === 'plot');
        plotDieValue = plotDieResult?.originalValue || plotDieResult?.value;
      }

      if (plotDie && plotDieValue) {
        if (plotDieValue === 5 || plotDieValue === 6) {
          return ' with Opportunity!';
        } else if (plotDieValue === 1 || plotDieValue === 2) {
          return ' with Complications';
        }
      }

      // Check status field as backup
      if (roll?.result?.status?.slug === 'opportunity') {
        return ' Opportunity!';
      } else if (roll?.result?.status?.slug === 'complication') {
        return ' Complications';
      }

      return '';
    },
    processDice: roll => {
      const diceArray = [];
      let operator = {};
      let plotDice = null;

      // Check if any dice in the roll need kh/kl operators
      if (roll.dice && roll.dice.length > 0) {
        const hasKeepHighest = roll.dice.some(d => d.type === 'kh');
        const hasKeepLowest = roll.dice.some(d => d.type === 'kl');
        if (hasKeepHighest) {
          operator = { k: 'h1' };
        } else if (hasKeepLowest) {
          operator = { k: 'l1' };
        }
      }

      // Handle main dice
      if (roll.results) {
        roll.results.forEach((result, index) => {
          result.dice.forEach(die => {
            const label = die.config.name;
            const isPlotDie = die.slug === 'plot';
            const groupSlug = die.groupSlug || (index === 0 ? 'main-d20-group' : 'damage-group');

            // Handle plot die separately
            if (isPlotDie) {
              // Store plot die for separate roll
              plotDice = {
                type: 'd6',
                value: die.originalValue || die.value,
                theme: undefined,
                label: 'Plot Die',
                groupSlug: 'plot-die',
              };
            } else {
              diceArray.push({
                type: die.value < 0 ? 'mod' : die.die,
                value: die.value,
                theme: undefined,
                label: label,
                groupSlug: groupSlug,
              });
            }
          });

          // Add modifiers for this result group
          if (roll.modifiersParsed && Array.isArray(roll.modifiersParsed)) {
            const modGroups = roll.modifiersParsed as ModifierEntry[][];
            const modGroup = modGroups[index];
            if (Array.isArray(modGroup)) {
              const addModifier = modGroup.find(m => m.purpose === 'add');
              if (addModifier && typeof addModifier.value === 'number' && addModifier.value !== 0) {
                diceArray.push({
                  type: 'mod',
                  value: addModifier.value,
                  theme: undefined,
                  groupSlug: index === 0 ? 'main-d20-group' : 'damage-group',
                });
              }
            }
          }
        });
      } else if (roll.result.dice) {
        roll.result.dice.forEach(die => {
          const value = die.config.isNegative ? -die.value : die.value;
          const label = die.config.name;
          const isPlotDie = die.slug === 'plot';

          if (isPlotDie) {
            // Store plot die for separate roll
            plotDice = {
              type: 'd6',
              value: die.originalValue || value,
              theme: undefined,
              label: 'Plot Die',
              groupSlug: 'plot-die',
            };
          } else {
            diceArray.push({
              type: die.die,
              value: value,
              theme: undefined,
              label: label,
            });
          }
        });
      }

      return {
        dice: diceArray,
        operator,
        plotDice,
      };
    },
    getCharacterNameSelector: '.character-name',
  },
  [GameSystem.UNKNOWN]: {
    pathRegex: /^\/nexus\/([^/]+)\/character-sheet\/([^/]+)/,
    storageKeyPattern: '{uuid}-dice-history',
    getRollName: roll => roll.name + (roll.origin ? ` (${roll.origin})` : ''),
    getTypeResult: () => '',
    processDice: roll => {
      const diceArray = [];

      // Handle the new structure with raw_dice
      if (roll?.result?.raw_dice?.parts) {
        let lastOperator = '+'; // Default operator is addition

        // Process each part of the roll (dice, operators, constants)
        for (const part of roll.result.raw_dice.parts) {
          if (part.type === 'dice') {
            // Process all dice in this part
            for (const die of part.dice) {
              if (die.type === 'single_dice') {
                diceArray.push({
                  type: `d${die.size}`, // d6, d20, etc.
                  value: die.value,
                  theme: undefined,
                  label: `${part.num_dice}d${die.size}`,
                });
              }
            }
          } else if (part.type === 'operator' && typeof part.value === 'string' && part.value) {
            // Store the last non-empty string operator
            lastOperator = part.value;
          } else if (part.type === 'constant') {
            // Add modifiers as static values, applying the last operator
            diceArray.push({
              type: 'mod',
              value: lastOperator === '-' ? -part.value : part.value,
              theme: undefined,
            });
          }
        }
      }
      // Handle the original structure
      else if (roll?.result?.dice) {
        roll.result.dice.forEach(die => {
          log.debug('Processing die:', die);
          diceArray.push({
            type: die.value > 0 ? die.die : 'mod',
            value: die.value,
            theme: undefined,
          });
        });

        // Add static modifier if present
        if (roll.modifiersParsed && Array.isArray(roll.modifiersParsed)) {
          const modifiers = roll.modifiersParsed as ModifierEntry[];
          const addModifier = modifiers.find(m => m.purpose === 'add');
          if (addModifier && typeof addModifier.value === 'number' && addModifier.value !== 0) {
            diceArray.push({
              type: 'mod',
              value: addModifier.value,
              theme: undefined,
            });
          }
        }
      }

      return diceArray;
    },
  },
};

let currentGameSystem: GameSystem = GameSystem.UNKNOWN;

function detectGameSystem(): { system: GameSystem; uuid: string | null } {
  for (const [system, config] of Object.entries(gameConfigs)) {
    const match = window.location.pathname.match(config.pathRegex);
    if (match) {
      // Store the detected game system in extension storage
      setStorage({ gameSystem: system });
      return {
        system: system as GameSystem,
        uuid: match[match.length - 1],
      };
    }
  }

  // If no specific system is detected, store the UNKNOWN type
  setStorage({ gameSystem: GameSystem.UNKNOWN });
  return { system: GameSystem.UNKNOWN, uuid: null };
}

function processRoll(roll: DiceRoll): void {
  log.debug('Processing roll:', {
    name: roll.name,
    dice: roll.dice ? roll.dice.map(d => d.die) : 'not available',
    modifiers: roll.modifiersParsed,
    result: roll.result,
  });

  const { system } = detectGameSystem();
  currentGameSystem = system;

  const result = gameConfigs[system].processDice(roll);
  const diceArray = Array.isArray(result) ? result : result.dice;
  const operator = Array.isArray(result) ? {} : result.operator;

  log.debug('Prepared dice array for 3D roll:', diceArray);
  log.debug('Prepared operator for 3D roll:', operator);
  sendRollRequest(diceArray, roll, operator);
}

async function watchLocalStorage(): Promise<void> {
  const { system, uuid } = detectGameSystem();
  currentGameSystem = system;
  log.debug('Detected game system:', system);
  log.debug('Detected character UUID:', uuid);
  log.debug('Current watchingStorage state:', watchingStorage);

  if (!uuid) {
    log.debug('No character UUID found in URL');
    return;
  }

  // If we're already watching storage for this session, don't set up another watcher
  if (watchingStorage) {
    log.debug('Already watching localStorage');
    return;
  }

  // For Unknown system, try both storage key patterns
  const storageKeys =
    system === GameSystem.UNKNOWN
      ? [
          gameConfigs[system].storageKeyPattern.replace('{uuid}', uuid),
          '{uuid}-dicerolls'.replace('{uuid}', uuid),
        ]
      : [gameConfigs[system].storageKeyPattern.replace('{uuid}', uuid)];

  log.debug(`Watching localStorage keys: ${storageKeys.join(', ')} for game system: ${system}`);

  // Initialize lastRolls with current state to prevent rolling on page load
  let lastRolls: DiceRoll[] | null = null;

  // Check each storage key for initial data
  for (const key of storageKeys) {
    const historyString = localStorage.getItem(key);
    if (historyString) {
      lastRolls = JSON.parse(historyString);
      log.debug(`Found initial data in ${key}`);
      break;
    }
  }

  const checkForNewRolls = async () => {
    let currentRolls: DiceRoll[] | null = null;

    // Check each storage key for new rolls
    for (const key of storageKeys) {
      const historyString = localStorage.getItem(key);
      if (historyString) {
        try {
          currentRolls = JSON.parse(historyString);
          break; // Use the first valid data found
        } catch (e) {
          log.debug(`Error parsing dice history from ${key}:`, e);
        }
      }
    }

    if (!currentRolls) {
      log.debug('No dice history found in any localStorage keys');
      return;
    }

    try {
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
            newestRoll.dice?.map(d => d.die)?.join(', ') || 'no dice array',
          );
          await updateParticipantName();
          processRoll(newestRoll);
        }
        lastRolls = currentRolls;
      }
    } catch (e) {
      log.error('Error processing rolls:', e);
    }
  };

  log.debug('Setting up interval for checking new rolls');
  // Set up the interval to watch for future changes
  setInterval(checkForNewRolls, 1000);
  watchingStorage = true; // Mark that we're watching storage
  log.debug('watchingStorage flag set to true');

  // Run an immediate check for dice history
  checkForNewRolls();
}

async function sendRollRequest(
  roll: Array<{
    type: string;
    value: number;
    theme: string | undefined;
    label?: string;
    groupSlug?: string;
  }>,
  originalRoll: DiceRoll,
  operator = {},
): Promise<void> {
  const [room, defaultTheme, hopeTheme, fearTheme] = await Promise.all([
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
          try {
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
    // Assign themes based on game system and die type
    roll.forEach(die => {
      if (currentGameSystem === GameSystem.DAGGERHEART) {
        if (die.label === 'Hope') {
          die.theme = hopeTheme?.id;
        } else if (die.label === 'Fear') {
          die.theme = fearTheme?.id;
        } else {
          die.theme = defaultTheme?.id;
        }
      } else {
        die.theme = defaultTheme?.id;
      }
    });

    if (!defaultTheme?.id) {
      log.debug('No theme selected, using default');
    }

    const { system } = detectGameSystem();
    const config = gameConfigs[system];

    // Special handling for CosmereRPG
    if (system === GameSystem.COSMERERPG) {
      const result = config.processDice(originalRoll);
      const baseLabel = config.getRollName(originalRoll);

      // Check if we have multiple results or a plot die
      let plotDie = null;
      if (!Array.isArray(result) && result.plotDice) {
        plotDie = result.plotDice;
        // Apply theme to plot die
        plotDie.theme = defaultTheme?.id;
      }

      // Check if this roll should split attack and damage
      const shouldSplitRoll = originalRoll.results && originalRoll.results.length > 1;

      // Always check for attack and damage dice for CosmereRPG
      if (shouldSplitRoll) {
        // Create attack roll
        const attackDice = roll.filter(
          die =>
            die.groupSlug === 'main-d20-group' ||
            (!die.groupSlug && die.groupSlug !== 'damage-group'),
        );
        if (attackDice.length > 0) {
          await dddice.api.roll.create(attackDice, { label: `${baseLabel} (Attack)`, operator });
        }

        // Create damage roll - include operator here since that's where kh/kl is used
        const damageDice = roll.filter(die => die.groupSlug === 'damage-group');
        if (damageDice.length > 0) {
          await dddice.api.roll.create(damageDice, { label: `${baseLabel} (Damage)`, operator });
        }

        // Send plot die separately if it exists
        if (plotDie) {
          await dddice.api.roll.create([plotDie], {
            label: `${baseLabel}${config.getTypeResult(originalRoll)}`,
          });
        }
      } else {
        // For single result rolls, handle plot die separately if it exists
        if (plotDie) {
          log.debug('Sending plot die:', plotDie);
          // Send main dice
          const mainDice = roll.filter(die => die.groupSlug !== 'plot-die');
          if (mainDice.length > 0) {
            log.debug('Sending main dice:', mainDice);
            await dddice.api.roll.create(mainDice, {
              label: `${baseLabel}${config.getTypeResult(originalRoll)}`,
              operator,
            });
          }
          // Send plot die separately
          log.debug('originalRoll:', originalRoll);
          await dddice.api.roll.create([plotDie], {
            label: `${baseLabel}${config.getTypeResult(originalRoll)}`,
          });
        } else {
          // No plot die, send as a single roll
          await dddice.api.roll.create(roll, {
            label: `${baseLabel}${config.getTypeResult(originalRoll)}`,
            operator,
          });
        }
      }
      return; // Return early since we've handled this roll
    }

    // For all other systems, proceed as normal
    const label = config.getRollName(originalRoll) + config.getTypeResult(originalRoll);
    await dddice.api.roll.create(roll, { label: label, operator });
  } catch (e: any) {
    log.error('Roll creation failed:', e);
    notify(
      `Failed to create roll: ${e.response?.data?.data?.message ?? e.message ?? 'Unknown error'}`,
    );
  }
}

async function initializeSDK(): Promise<void> {
  const [apiKey, room, theme, hopeTheme, fearTheme, renderMode] = await Promise.all([
    getStorage('apiKey'),
    getStorage('room'),
    getStorage('theme'),
    getStorage('hopeTheme'),
    getStorage('fearTheme'),
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

    // Preload additional themes for Daggerheart if we're on a Daggerheart page
    if (currentGameSystem === GameSystem.DAGGERHEART) {
      if (hopeTheme) preloadTheme(hopeTheme);
      if (fearTheme) preloadTheme(fearTheme);
    }

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
    dddice.loadThemeResources(theme.id, true);
    return Promise.resolve();
  } catch (e) {
    log.debug('Error preloading theme:', e);
    return Promise.reject(e);
  }
}

async function updateParticipantName() {
  const room = await getStorage('room');
  if (!user) {
    try {
      user = (await dddice?.api?.user.get())?.data;
    } catch (e) {
      log.debug('Failed to get user', e);
      return;
    }
  }

  const { system } = detectGameSystem();
  const config = gameConfigs[system];
  const characterNameSelector = config.getCharacterNameSelector;

  if (!characterNameSelector) return;

  if (room && user) {
    const userParticipant = room.participants.find(
      ({ user: { uuid: participantUuid } }) => participantUuid === user.uuid,
    );
    const characterName = document.querySelector<HTMLElement>(characterNameSelector)?.textContent;

    log.debug('Character name:', characterName);
    log.debug('User participant:', userParticipant.username);

    if (userParticipant && userParticipant.username !== characterName) {
      userParticipant.username = characterName;
      setStorage({ room });
      await dddice?.api?.room.updateParticipant(room.slug, userParticipant.id, {
        username: characterName,
      });
      log.debug('Updated character name in room:', characterName);
    }
  }
}

async function init() {
  const { system, uuid } = detectGameSystem();
  currentGameSystem = system;

  if (!uuid) {
    log.debug('uninit: not on a character sheet page');
    const currentCanvas = document.getElementById('dddice-canvas');
    if (currentCanvas) {
      currentCanvas.remove();
      dddice = undefined as unknown as ThreeDDice;
    }
    return;
  }

  log.debug(`init: on ${system} character sheet page`);

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
    if (!watchingStorage) {
      log.debug('Starting localStorage watch for dice rolls');
      watchLocalStorage();
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
      init();
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
