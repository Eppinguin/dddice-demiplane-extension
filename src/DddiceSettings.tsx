/** @format */

import React, { useCallback, useEffect, useState, useRef } from 'react';
import ReactTooltip from 'react-tooltip';
import { IRoom, ITheme, ThreeDDiceAPI } from 'dddice-js';

import Back from './assets/interface-essential-left-arrow.svg';
import Loading from './assets/loading.svg';
import LogOut from './assets/interface-essential-exit-door-log-out-1.svg';
import Help from './assets/support-help-question-question-square.svg';
import imageLogo from 'url:./assets/dddice-48x48.png';

import RoomSelection from './components/RoomSelection';

import Room from './components/Room';
import ThemeSelection from './components/ThemeSelection';
import Theme from './components/Theme';

import StorageProvider from './StorageProvider';
import SdkBridge from './SdkBridge';
import PermissionProvider from './PermissionProvider';
import Toggle from './components/Toggle';
import { CustomConfiguration } from './schema/custom_configuration';
import CodeActivationScreen from './ts/Partials/CodeActivationScreen';

// Game system enum that matches the one in demiplane.tsx
enum GameSystem {
  DAGGERHEART = 'daggerheart',
  COSMERERPG = 'cosmererpg',
  AVATARLEGENDS = 'avatarlegends',
  UNKNOWN = 'unknown',
}

export interface IStorage {
  apiKey?: string;
  room?: IRoom;
  theme?: ITheme;
  themes?: ITheme[];
  rooms?: IRoom[];
  renderMode: boolean;
  hopeTheme?: ITheme; // Daggerheart specific
  fearTheme?: ITheme; // Daggerheart specific
  plotDieTheme?: ITheme; // Cosmere RPG specific
  gameSystem?: GameSystem; // Track current game system
  loaded: boolean;
}

export const DefaultStorage: IStorage = {
  apiKey: undefined,
  room: undefined,
  theme: undefined,
  themes: undefined,
  rooms: undefined,
  renderMode: true,
  hopeTheme: undefined,
  fearTheme: undefined,
  plotDieTheme: undefined,
  gameSystem: undefined,
  loaded: false,
};

interface DddiceSettingsProps {
  storageProvider: StorageProvider;
  sdkBridge: SdkBridge;
  permissionProvider: PermissionProvider;
}

const DddiceSettings = (props: DddiceSettingsProps) => {
  const { storageProvider, sdkBridge, permissionProvider } = props;

  /**
   * API
   */
  const api = useRef(ThreeDDiceAPI);

  /**
   * Storage Object
   */
  const [state, setState] = useState(DefaultStorage);

  /**
   * Loading
   */
  const [isLoading, setIsLoading] = useState(0);

  const pushLoading = () => setIsLoading(isLoading => isLoading + 1);
  const popLoading = () => setIsLoading(isLoading => Math.max(isLoading - 1, 0));
  const clearLoading = () => setIsLoading(0);

  /**
   * Loading
   */
  const [loadingMessage, setLoadingMessage] = useState('');

  /**
   * Connected
   */
  const [isConnected, setIsConnected] = useState(false);

  /**
   * Error
   */
  const [error, setError] = useState<string>();

  /**
   * Current VTT
   */
  const [vtt, setVTT] = useState(undefined);

  const [isEnterApiKey, setIsEnterApiKey] = useState(false);

  const [externalConfiguration, setExternalConfiguration] = useState<
    CustomConfiguration | undefined
  >(undefined);

  /**
   * Connect to VTT
   * Mount / Unmount
   */
  useEffect(() => {
    async function connect() {
      const platform = await sdkBridge.detectPlatform();
      if (platform) {
        setVTT(platform);
      }
    }

    connect();
  }, []);

  // Detect the game system from URL or storage
  useEffect(() => {
    async function detectGameSystem() {
      // Try to get game system from storage first
      const gameSystem = await storageProvider.getStorage('gameSystem');
      if (gameSystem) {
        setState(state => ({ ...state, gameSystem }));
      }
    }
    detectGameSystem();
  }, []);

  useEffect(() => {
    async function initStorage() {
      const [
        apiKey,
        room,
        theme,
        rooms,
        themes,
        renderMode,
        hopeTheme,
        fearTheme,
        plotDieTheme,
        gameSystem,
      ] = await Promise.all([
        storageProvider.getStorage('apiKey'),
        storageProvider.getStorage('room'),
        storageProvider.getStorage('theme'),
        storageProvider.getStorage('rooms'),
        storageProvider.getStorage('themes'),
        storageProvider.getStorage('render mode'),
        storageProvider.getStorage('hopeTheme'),
        storageProvider.getStorage('fearTheme'),
        storageProvider.getStorage('plotDieTheme'),
        storageProvider.getStorage('gameSystem'),
      ]);

      setState((storage: IStorage) => ({
        ...storage,
        apiKey,
        room,
        theme,
        rooms,
        themes,
        renderMode: renderMode === undefined ? true : renderMode,
        hopeTheme, // Set Hope theme
        fearTheme, // Set Fear theme
        plotDieTheme, // Set Plot die theme
        gameSystem,
        loaded: true,
      }));
    }

    initStorage();
  }, []);

  useEffect(() => {
    async function init() {
      pushLoading();
      sdkBridge.queryCustomConfiguration();
      setTimeout(async () => {
        const customConfiguration = await storageProvider.getStorage('customConfiguration');
        if (customConfiguration && Date.now() - customConfiguration.lastUpdated <= 600) {
          setExternalConfiguration(customConfiguration);
        }
        popLoading();
      }, 500);
    }
    if (isConnected) {
      init();
    }
  }, [isConnected]);

  const onChangeHopeTheme = useCallback((theme: ITheme) => {
    setState((storage: IStorage) => ({
      ...storage,
      hopeTheme: theme,
    }));

    if (theme) {
      storageProvider.setStorage({ hopeTheme: theme });
      preloadTheme(theme);
    }

    ReactTooltip.hide();
  }, []);

  const onChangeFearTheme = useCallback((theme: ITheme) => {
    setState((storage: IStorage) => ({
      ...storage,
      fearTheme: theme,
    }));

    if (theme) {
      storageProvider.setStorage({ fearTheme: theme });
      preloadTheme(theme);
    }

    ReactTooltip.hide();
  }, []);

  const onChangePlotDieTheme = useCallback((theme: ITheme) => {
    setState((storage: IStorage) => ({
      ...storage,
      plotDieTheme: theme,
    }));

    if (theme) {
      storageProvider.setStorage({ plotDieTheme: theme });
      preloadTheme(theme);
    } else {
      storageProvider.removeStorage('plotDieTheme');
    }

    ReactTooltip.hide();
  }, []);

  const refreshThemes = async () => {
    let themes: ITheme[] = [];
    pushLoading();
    setLoadingMessage('Loading themes (1)');
    let _themes = (await api.current.diceBox.list()).data;

    let page = 1;
    while (_themes) {
      setLoadingMessage(`Loading themes (${page++})`);
      themes = [...themes, ..._themes];
      _themes = (await api.current.diceBox.next())?.data;
    }
    storageProvider.setStorage({ themes });
    setState(state => ({
      ...state,
      themes,
    }));
    popLoading();
  };

  const refreshRoom = useCallback(async () => {
    if (state?.room?.slug) {
      setLoadingMessage('refreshing room data');
      pushLoading();
      const room = (await api.current.room.get(state.room.slug)).data;
      if (permissionProvider.canChangeRoom()) {
        storageProvider.setStorage({ room });
      }
      setState(state => ({ ...state, room }));
      popLoading();
    }
  }, [state?.room?.slug]);

  const refreshRooms = async () => {
    setLoadingMessage('Loading rooms list');
    pushLoading();
    const rooms = (await api.current.room.list()).data;
    storageProvider.setStorage({ rooms });
    setState(state => ({ ...state, rooms }));
    popLoading();
  };

  useEffect(() => {
    if (state.apiKey) {
      api.current = new ThreeDDiceAPI(state.apiKey, 'browser extension');

      const load = async () => {
        pushLoading();

        try {
          if (!state.rooms || state.rooms.length === 0) {
            await refreshRooms();
          }

          if (state.room) {
            await refreshRoom();
          }

          if (!state.themes || state.themes.length === 0) {
            await refreshThemes();
          }
          popLoading();
        } catch (error) {
          setError('Problem connecting with dddice');
          clearLoading();
          return;
        }
      };

      load();
    }
  }, [state.apiKey]);

  useEffect(() => {
    ReactTooltip.rebuild();
  });

  const reloadDiceEngine = async () => {
    await sdkBridge.reloadDiceEngine();
  };

  const preloadTheme = async (theme: ITheme) => {
    return sdkBridge.preloadTheme(theme);
  };

  const onJoinRoom = useCallback(
    async (roomSlug: string, passcode?: string) => {
      if (roomSlug) {
        setLoadingMessage('Joining room');
        pushLoading();
        //await createGuestAccountIfNeeded();
        const room = state.rooms && state.rooms.find(r => r.slug === roomSlug);
        if (room) {
          onChangeRoom(room);
        } else {
          let newRoom;
          try {
            newRoom = (await api.current.room.join(roomSlug, passcode)).data;
          } catch (error) {
            setError('could not join room');
            clearLoading();
            throw error;
          }
          if (newRoom) {
            await storageProvider.setStorage({
              rooms: state.rooms ? [...state.rooms, newRoom] : [newRoom],
            });
            setState((storage: IStorage) => ({
              ...storage,
              rooms: storage.rooms ? [...storage.rooms, newRoom] : [newRoom],
            }));
            await onChangeRoom(newRoom);
          }
        }
        popLoading();
      }
    },
    [state],
  );

  const onChangeRoom = useCallback(
    async (room: IRoom) => {
      // if room isn't in rooms list, assume it needs to be joined

      setState((storage: IStorage) => ({
        ...storage,
        room,
      }));

      ReactTooltip.hide();
      if (room) {
        if (permissionProvider.canChangeRoom()) {
          await storageProvider.setStorage({ room });
        }
        await reloadDiceEngine();
      }
    },
    [state.rooms],
  );

  const onCreateRoom = useCallback(async () => {
    setLoadingMessage('Creating Room');
    pushLoading();
    await createGuestAccountIfNeeded();
    let newRoom;
    try {
      newRoom = (await api.current.room.create()).data;
    } catch (error) {
      setError('could not create room');
      clearLoading();
      throw error;
    }
    if (newRoom) {
      await storageProvider.setStorage({
        rooms: state.rooms ? [...state.rooms, newRoom] : [newRoom],
      });
      setState((storage: IStorage) => ({
        ...storage,
        rooms: storage.rooms ? [...storage.rooms, newRoom] : [newRoom],
      }));
    }

    setState((storage: IStorage) => ({
      ...storage,
      room: newRoom,
    }));
    if (permissionProvider.canChangeRoom()) {
      await storageProvider.setStorage({ room: newRoom });
    }
    popLoading();
    await reloadDiceEngine();
  }, [state.rooms]);

  const onChangeTheme = useCallback((theme: ITheme) => {
    setState((storage: IStorage) => ({
      ...storage,
      theme,
    }));

    if (theme) {
      storageProvider.setStorage({ theme });
      preloadTheme(theme);
    }

    ReactTooltip.hide();
  }, []);

  const onKeySuccess = useCallback((apiKey: string) => {
    setState((storage: IStorage) => ({
      ...storage,
      apiKey,
      rooms: undefined,
      themes: undefined,
    }));
    storageProvider.setStorage({ apiKey });
    setIsEnterApiKey(false);
    reloadDiceEngine();
  }, []);

  const onSignOut = useCallback(() => {
    setState({ ...DefaultStorage, loaded: true });
    storageProvider.removeStorage('apiKey');
    storageProvider.removeStorage('theme');
    if (permissionProvider.canChangeRoom()) {
      storageProvider.removeStorage('room');
    }
    storageProvider.removeStorage('rooms');
    storageProvider.removeStorage('themes');
    storageProvider.removeStorage('activate');
    storageProvider.removeStorage('hopeTheme');
    storageProvider.removeStorage('fearTheme');
    setError(undefined);
    clearLoading();
  }, []);

  const onSwitchRoom = useCallback(async () => {
    onChangeRoom(undefined);
  }, []);

  const onSwitchTheme = useCallback(async () => {
    onChangeTheme(undefined);
  }, []);

  const createGuestAccountIfNeeded = useCallback(async () => {
    if (!state.apiKey || !api.current) {
      try {
        const apiKey = (await new ThreeDDiceAPI(undefined, 'browser extension').user.guest()).data;
        api.current = new ThreeDDiceAPI(apiKey, 'browser extension');
        setState((storage: IStorage) => ({
          ...storage,
          apiKey,
        }));
        await storageProvider.setStorage({ apiKey });
      } catch (error) {
        setError('could not create room');
        clearLoading();
        throw error;
      }
    }
  }, [state]);

  // Render the appropriate theme selectors based on game system
  const renderGameSpecificThemeSelectors = () => {
    switch (state.gameSystem) {
      case GameSystem.DAGGERHEART:
        return (
          <>
            <div className="text-white text-lg font-bold mt-4 mb-2">Daggerheart Special Dice</div>
            {/* Hope Theme */}
            {!state.hopeTheme ? (
              <ThemeSelection
                themes={state.themes}
                onSelectTheme={onChangeHopeTheme}
                onConnectAccount={() => setIsEnterApiKey(true)}
                onRefreshThemes={refreshThemes}
                label="Hope Die"
              />
            ) : (
              <Theme
                theme={state.hopeTheme}
                onSwitchTheme={() => onChangeHopeTheme(undefined)}
                label="Hope Die"
              />
            )}
            {/* Fear Theme */}
            {!state.fearTheme ? (
              <ThemeSelection
                themes={state.themes}
                onSelectTheme={onChangeFearTheme}
                onConnectAccount={() => setIsEnterApiKey(true)}
                onRefreshThemes={refreshThemes}
                label="Fear Die"
              />
            ) : (
              <Theme
                theme={state.fearTheme}
                onSwitchTheme={() => onChangeFearTheme(undefined)}
                label="Fear Die"
              />
            )}
          </>
        );

      case GameSystem.COSMERERPG:
        return (
          <>
            <div className="text-white text-lg font-bold mt-4 mb-2">Cosmere RPG Special Dice</div>
            {/* Plot Die Theme */}
            {!state.plotDieTheme ? (
              <ThemeSelection
                themes={state.themes}
                onSelectTheme={onChangePlotDieTheme}
                onConnectAccount={() => setIsEnterApiKey(true)}
                onRefreshThemes={refreshThemes}
                label="Plot Die"
              />
            ) : (
              <Theme
                theme={state.plotDieTheme}
                onSwitchTheme={() => onChangePlotDieTheme(undefined)}
                label="Plot Die"
              />
            )}
          </>
        );

      default:
        return null;
    }
  };

  /**
   * Render
   */
  return (
    <div className="px-4 pt-2 pb-4 scroll !font-sans !text-xs">
      <ReactTooltip effect="solid" />
      {state.loaded && (
        <>
          <div className="flex flex-row items-baseline justify-center">
            {isEnterApiKey ? (
              <span
                className="text-gray-300 text-xxs mr-auto cursor-pointer"
                onClick={() => setIsEnterApiKey(false)}
              >
                <Back className="flex h-4 w-4 m-auto" data-tip="Back" data-place="right" />
              </span>
            ) : (
              <a
                className="!text-gray-300 text-xxs mr-auto"
                href="https://docs.dddice.com/docs/integrations/browser-extension"
                target="_blank"
              >
                <Help className="flex h-4 w-4 m-auto" data-tip="Help" data-place="right" />
              </a>
            )}
            {state.apiKey && (
              <span className="text-gray-300 text-xxs ml-auto cursor-pointer" onClick={onSignOut}>
                <LogOut className="flex h-4 w-4 m-auto" data-tip="Logout" data-place="left" />
              </span>
            )}
          </div>
        </>
      )}
      <div className="flex flex-col items-center justify-center">
        <img src={imageLogo} alt="dddice" />
        <span className="text-white text-lg">dddice</span>
      </div>
      {externalConfiguration && (
        <div className="flex flex-col space-y-1 items-center justify-center">
          <span className="text-white text-lg">Configuration is being controlled by</span>
          <img src={externalConfiguration.icon} alt="configuration system" />
          <div className="flex flex-col items-center space-y-3">
            <p className="text-white">You can change your theme there</p>
            <p className="text-white space-y-2">Room: {(state.room || { name: 'Unknown' }).name}</p>
          </div>
        </div>
      )}
      {error && (
        <div className="text-gray-700 mt-4">
          <p className="text-center text-neon-red">{error}</p>
        </div>
      )}
      {!state.apiKey && state.loaded ? (
        <CodeActivationScreen setApiKey={onKeySuccess} />
      ) : (
        !externalConfiguration && (
          <>
            {isLoading || !state.loaded ? (
              <div className="flex flex-col justify-center text-gray-700 mt-4">
                <Loading className="flex h-10 w-10 animate-spin-slow m-auto" />
                <div className="flex m-auto text-gray-300">{loadingMessage}</div>
                <div className="flex m-auto text-gray-300">keep extension open while loading</div>
              </div>
            ) : (
              <>
                {(!state.apiKey || !state.room) && permissionProvider.canChangeRoom() ? (
                  <RoomSelection
                    rooms={state.rooms}
                    onSelectRoom={onChangeRoom}
                    onJoinRoom={onJoinRoom}
                    onError={setError}
                    onConnectAccount={() => setIsEnterApiKey(true)}
                    onCreateRoom={onCreateRoom}
                    onRefreshRooms={refreshRooms}
                  />
                ) : !state.theme ? (
                  <>
                    <div className="text-white text-lg font-bold mt-4 mb-2">
                      Select Default Dice Theme
                    </div>
                    <ThemeSelection
                      themes={state.themes}
                      onSelectTheme={onChangeTheme}
                      onConnectAccount={() => setIsEnterApiKey(true)}
                      onRefreshThemes={refreshThemes}
                    />
                  </>
                ) : (
                  <>
                    <Room
                      room={state.room || { name: 'No Room Selected' }}
                      onSwitchRoom={onSwitchRoom}
                      disabled={!permissionProvider.canChangeRoom()}
                    />
                    <div className="text-white text-lg font-bold mt-4 mb-2">Default Dice Theme</div>
                    <Theme theme={state.theme} onSwitchTheme={onSwitchTheme} label="Default" />

                    {/* Render game-specific theme selectors */}
                    {renderGameSpecificThemeSelectors()}

                    <div className="py-3 flex items-center justify-between">
                      <span className="text-lg font-bold text-gray-300 flex-1">Render Dice</span>
                      <div>
                        <Toggle
                          value={state.renderMode}
                          onChange={async value => {
                            setState(state => ({ ...state, renderMode: value }));
                            await storageProvider.setStorage({ 'render mode': value });
                            sdkBridge.reloadDiceEngine();
                          }}
                        />
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )
      )}
      {!state.loaded && (
        <div className="flex justify-center text-gray-700 mt-4">
          <span className="text-center text-gray-300">Not connected.</span>
        </div>
      )}
      <p className="border-t border-gray-800 mt-4 pt-4 text-gray-700 text-xxs text-center">
        {state.loaded && (
          <>
            <span className="text-gray-300">Connected to {vtt}</span>
            <span className="text-gray-700">{' | '}</span>
          </>
        )}
        dddice {process.env.VERSION}
      </p>
    </div>
  );
};

export default DddiceSettings;
