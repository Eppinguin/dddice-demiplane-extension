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
let isInitialized = false;
let watchingStorage = false;

enum GameSystem {
  AVATARLEGENDS = 'avatarlegends',
  DAGGERHEART = 'daggerheart',
  COSMERERPG = 'cosmererpg',
  UNKNOWN = 'unknown',
}

interface GameConfig {
  pathRegex: RegExp;
  storageKeyPattern: string;
  getRollName: (roll: DiceRoll) => string;
  getTypeResult: (roll: DiceRoll) => string;
  processDice: (roll: DiceRoll) => {
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
  name: string;
  type?: string;
  dice?: Array<{
    slug: string;
    die: string;
    type?: string;
    label: string;
    image: string;
    pooledImage: string;
  }>;
  roll?: string;
  modifiersParsed?: ModifierEntry[] | ModifierEntry[][] | ModifierEntry;
  rerolled?: boolean;
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
  result: {
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

const baseConfig: GameConfig = {
  pathRegex: /^\/nexus\/([^/]+)\/character-sheet\/([^/]+)/,
  storageKeyPattern: '{uuid}-dice-history',
  getRollName: roll => roll.name + (roll.origin ? ` (${roll.origin})` : ''),
  getTypeResult: () => '',
  processDice: roll => {
    const diceArray = [];
    const negativeIndices: number[] = [];

    if (roll?.result?.raw_dice?.parts) {
      let lastOperator = '+';

      for (const part of roll.result.raw_dice.parts) {
        if (part.type === 'dice') {
          for (const die of part.dice) {
            if (die.type === 'single_dice') {
              const dieIndex = diceArray.length;
              diceArray.push({
                type: `d${die.size}`,
                value: die.value,
                theme: undefined,
                label: `${part.num_dice}d${die.size}`,
              });

              if (lastOperator === '-') {
                negativeIndices.push(dieIndex);
              }
            }
          }
        } else if (part.type === 'operator' && typeof part.value === 'string' && part.value) {
          lastOperator = part.value;
        } else if (part.type === 'constant') {
          diceArray.push({
            type: 'mod',
            value: lastOperator === '-' ? -part.value : part.value,
            theme: undefined,
          });
        }
      }
    } else if (roll?.result?.dice) {
      roll.result.dice.forEach(die => {
        log.debug('Processing die:', die);
        const dieIndex = diceArray.length;

        if (die.value < 0 && die.die !== 'mod') {
          // Handle negative dice using operator instead of converting to mod
          diceArray.push({
            type: die.die,
            value: Math.abs(die.value),
            theme: undefined,
          });
          negativeIndices.push(dieIndex);
        } else {
          diceArray.push({
            type: die.value > 0 ? die.die : 'mod',
            value: die.value,
            theme: undefined,
          });
        }
      });

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

    const operator = negativeIndices.length > 0 ? { '*': { '-1': negativeIndices } } : {};
    return { dice: diceArray, operator, plotDice: undefined };
  },
};

const gameConfigs: Record<GameSystem, GameConfig> = {
  [GameSystem.AVATARLEGENDS]: {
    ...baseConfig,
    pathRegex: /^\/nexus\/avatarlegends\/character-sheet\/([^/]+)/,
    storageKeyPattern: '{uuid}-dicerolls',
    getTypeResult: roll => {
      if (roll.result.total > 10) {
        return ' (strong hit)';
      }
      if (roll.result.total > 7) {
        return ' (weak hit)';
      }
      return ' (miss)';
    },
  },
  [GameSystem.DAGGERHEART]: {
    ...baseConfig,
    pathRegex: /^\/nexus\/daggerheart\/(character-sheet|npc-sheet)\/([^/]+)/,
    getRollName: roll => {
      log.debug('Roll:', roll);
      if (Array.isArray(roll.modifiersParsed)) {
        const modifiers = roll.modifiersParsed as ModifierEntry[];
        const miscValues = modifiers
          .filter(m => m.purpose === 'misc' && m.value !== 'damage' && typeof m.value === 'string')
          .map(m => m.value);

        if (miscValues.length > 0) {
          return miscValues.join(': ');
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
      const negativeIndices: number[] = [];

      roll.result.dice.forEach(die => {
        const label = die.config.name;
        log.debug('Processing die:', die);
        const dieIndex = diceArray.length;

        if (die.value < 0 && die.die !== 'mod') {
          // Handle negative dice using operator instead of converting to mod
          diceArray.push({
            type: die.die,
            value: Math.abs(die.value),
            theme: undefined,
            label,
          });
          negativeIndices.push(dieIndex);
        } else {
          diceArray.push({
            type: die.value > 0 ? die.die : 'mod',
            value: die.value,
            theme: undefined,
            label,
          });
        }
      });

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

      const operator = negativeIndices.length > 0 ? { '*': { '-1': negativeIndices } } : {};
      return { dice: diceArray, operator, plotDice: undefined };
    },
    getCharacterNameSelector: '.character-name',
  },
  [GameSystem.COSMERERPG]: {
    ...baseConfig,
    pathRegex: /^\/nexus\/cosmererpg\/character-sheet\/([^/]+)/,
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
      const plotDie = roll.dice?.find(d => d.slug === 'plot');
      let plotDieValue;

      if (roll.results && roll.results.length > 0) {
        const plotDieResult = roll.results[0]?.dice.find(d => d.slug === 'plot');
        plotDieValue = plotDieResult?.originalValue || plotDieResult?.value;
      }

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

      if (roll?.result?.status?.slug === 'opportunity') {
        return ' Opportunity!';
      } else if (roll?.result?.status?.slug === 'complication') {
        return ' Complications';
      }

      return '';
    },
    processDice: roll => {
      const diceArray = [];
      const negativeIndices: number[] = [];
      let operator = {};
      let plotDice = null;

      if (roll.dice && roll.dice.length > 0) {
        const hasKeepHighest = roll.dice.some(d => d.type === 'kh');
        const hasKeepLowest = roll.dice.some(d => d.type === 'kl');
        if (hasKeepHighest) {
          operator = { k: 'h1' };
        } else if (hasKeepLowest) {
          operator = { k: 'l1' };
        }
      }

      if (roll.results) {
        roll.results.forEach((result, index) => {
          result.dice.forEach(die => {
            const label = die.config.name;
            const isPlotDie = die.slug === 'plot';
            const groupSlug = die.groupSlug || (index === 0 ? 'main-d20-group' : 'damage-group');

            if (isPlotDie) {
              plotDice = {
                type: 'setback', // This will be checked against theme later in sendRollRequest
                value: die.originalValue || die.value,
                theme: undefined,
                label: 'Plot Die',
                groupSlug: 'plot-die',
              };
            } else {
              const dieIndex = diceArray.length;

              if (die.value < 0 && die.die !== 'mod') {
                // Handle negative dice using operator instead of converting to mod
                diceArray.push({
                  type: die.die,
                  value: Math.abs(die.value),
                  theme: undefined,
                  label: label,
                  groupSlug: groupSlug,
                });
                negativeIndices.push(dieIndex);
              } else {
                diceArray.push({
                  type: die.value < 0 ? 'mod' : die.die,
                  value: die.value,
                  theme: undefined,
                  label: label,
                  groupSlug: groupSlug,
                });
              }
            }
          });

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
            plotDice = {
              type: 'setback', // This will be checked against theme later in sendRollRequest
              value: die.originalValue || value,
              theme: undefined,
              label: 'Plot Die',
              groupSlug: 'plot-die',
            };
          } else {
            const dieIndex = diceArray.length;

            if (value < 0 && die.die !== 'mod') {
              // Handle negative dice using operator instead of converting to mod
              diceArray.push({
                type: die.die,
                value: Math.abs(value),
                theme: undefined,
                label: label,
              });
              negativeIndices.push(dieIndex);
            } else {
              diceArray.push({
                type: die.die,
                value: value,
                theme: undefined,
                label: label,
              });
            }
          }
        });
      }

      // Merge negative indices operator with existing operator (like keep highest/lowest)
      if (negativeIndices.length > 0) {
        operator = { ...operator, '*': { '-1': negativeIndices } };
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
    ...baseConfig,
  },
};

let currentGameSystem: GameSystem = GameSystem.UNKNOWN;

function detectGameSystem(): { system: GameSystem; uuid: string | null } {
  for (const [system, config] of Object.entries(gameConfigs)) {
    const match = window.location.pathname.match(config.pathRegex);
    if (match) {
      setStorage({ gameSystem: system });
      return {
        system: system as GameSystem,
        uuid: match[match.length - 1],
      };
    }
  }

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
  const diceArray = result.dice;
  const operator = result.operator;

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

  if (watchingStorage) {
    log.debug('Already watching localStorage');
    return;
  }

  const storageKeys =
    system === GameSystem.UNKNOWN
      ? [
          gameConfigs[system].storageKeyPattern.replace('{uuid}', uuid),
          '{uuid}-dicerolls'.replace('{uuid}', uuid),
        ]
      : [gameConfigs[system].storageKeyPattern.replace('{uuid}', uuid)];

  log.debug(`Watching localStorage keys: ${storageKeys.join(', ')} for game system: ${system}`);

  let lastRolls: DiceRoll[] | null = null;

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

    for (const key of storageKeys) {
      const historyString = localStorage.getItem(key);
      if (historyString) {
        try {
          currentRolls = JSON.parse(historyString);
          break;
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
  setInterval(checkForNewRolls, 1000);
  watchingStorage = true;
  log.debug('watchingStorage flag set to true');

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
  const [room, defaultTheme, hopeTheme, fearTheme, plotDieTheme] = await Promise.all([
    getStorage('room'),
    getStorage('theme'),
    getStorage('hopeTheme'),
    getStorage('fearTheme'),
    getStorage('plotDieTheme'),
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

  if (dddice) {
    log.debug('Waiting for 3D engine to initialize...');
    try {
      await new Promise<void>((resolve, reject) => {
        let attempts = 0;
        const maxAttempts = 50;
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

    if (system === GameSystem.COSMERERPG) {
      const result = config.processDice(originalRoll);
      const baseLabel = config.getRollName(originalRoll);

      let plotDie = null;
      if ('plotDice' in result && result.plotDice) {
        plotDie = result.plotDice;
        // Apply plot die theme if available
        plotDie.theme = plotDieTheme?.id || defaultTheme?.id;

        // Check if the selected theme supports 'setback' die type by looking at available_dice array
        const themeToCheck = plotDieTheme || defaultTheme;
        if (themeToCheck) {
          // Default to d6 unless we find "setback" in available dice
          plotDie.type = 'd6';

          // Check if theme has the setback die type
          if (themeToCheck.available_dice && Array.isArray(themeToCheck.available_dice)) {
            const hasSetback = themeToCheck.available_dice.some(die => die.id === 'setback');
            if (hasSetback) {
              plotDie.type = 'setback';
            }
          }
        }
      }

      const shouldSplitRoll = originalRoll.results && originalRoll.results.length > 1;

      if (shouldSplitRoll) {
        const attackDice = roll.filter(
          die =>
            die.groupSlug === 'main-d20-group' ||
            (!die.groupSlug && die.groupSlug !== 'damage-group'),
        );

        // Get the original roll name without "Attack Roll: " prefix if present
        let baseLabelText = baseLabel;
        if (baseLabelText.startsWith('Attack Roll:')) {
          baseLabelText = baseLabelText.substring('Attack Roll:'.length).trim();
        }

        if (attackDice.length > 0) {
          await dddice.api.roll.create(attackDice, {
            label: `Attack Roll: ${baseLabelText}`,
            operator,
          });
        }

        const damageDice = roll.filter(die => die.groupSlug === 'damage-group');
        if (damageDice.length > 0) {
          await dddice.api.roll.create(damageDice, {
            label: `Damage Roll: ${baseLabelText}`,
            operator,
          });
        }

        if (plotDie) {
          await dddice.api.roll.create([plotDie], {
            label: `Plot Die: ${baseLabelText}${config.getTypeResult(originalRoll)}`,
          });
        }
      } else {
        if (plotDie) {
          log.debug('Sending plot die:', plotDie);
          log.debug('Plot die theme:', plotDie.theme);
          const mainDice = roll.filter(die => die.groupSlug !== 'plot-die');
          if (mainDice.length > 0) {
            log.debug('Sending main dice:', mainDice);
            await dddice.api.roll.create(mainDice, {
              label: `${baseLabel}${config.getTypeResult(originalRoll)}`,
              operator,
            });
          }
          log.debug('originalRoll:', originalRoll);
          await dddice.api.roll.create([plotDie], {
            label: `${baseLabel}${config.getTypeResult(originalRoll)}`,
          });
        } else {
          await dddice.api.roll.create(roll, {
            label: `${baseLabel}${config.getTypeResult(originalRoll)}`,
            operator,
          });
        }
      }
      return;
    }

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
  const [apiKey, room, theme, hopeTheme, fearTheme, plotDieTheme, renderMode] = await Promise.all([
    getStorage('apiKey'),
    getStorage('room'),
    getStorage('theme'),
    getStorage('hopeTheme'),
    getStorage('fearTheme'),
    getStorage('plotDieTheme'),
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

    if (currentGameSystem === GameSystem.COSMERERPG) {
      if (plotDieTheme) preloadTheme(plotDieTheme);
    }

    if (currentGameSystem === GameSystem.DAGGERHEART) {
      if (hopeTheme) preloadTheme(hopeTheme);
      if (fearTheme) preloadTheme(fearTheme);
    }

    isInitialized = true;
    setStorage({ demiplane_initialized: true });

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

async function preloadTheme(theme: ITheme): Promise<void> {
  if (!theme || !dddice) {
    log.debug('Cannot preload theme: missing theme or dddice instance');
    return Promise.resolve();
  }

  try {
    log.debug('Preloading theme:', theme);
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

  if (!isInitialized && !dddice?.api) {
    const initialized = await getStorage('demiplane_initialized');
    const apiKey = await getStorage('apiKey');

    log.debug('Checking initialization state:', { initialized, apiKeyExists: !!apiKey });

    if (apiKey) {
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

window.addEventListener('load', () => init());
window.addEventListener('resize', () => init());

init();

let lastUrl = window.location.href;
new MutationObserver(() => {
  const currentUrl = window.location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    log.debug('URL changed, reinitializing extension');
    init();
  }
}).observe(document, { subtree: true, childList: true });
