import path from 'path';
import is from 'electron-is';
import ScreenManager from 'main/lib/screen-manager';
import DefaultMenuTemplate from 'main/lib/default-menu';
import * as IPCRouting from 'shared/ipc-routing';
import { ipcMain, IpcMainEvent, Menu } from 'electron';
import { IpcRequest } from 'shared/types';
import { AppLogo } from 'main/lib/cached-image';


/**
 * Module level variables, constants, and types
 */

// variables
const applogo = new AppLogo();


// constants
const PORT = process.env.PORT || 3000;
const WIDTH = 1024;
const HEIGHT = 768;
const CONFIG = {
  url: is.production()
    ? `file://${path.join( __dirname, 'dist/renderer/screens/main/index.html' )}`
    : `http://localhost:${PORT}/screens/main/index.html`,
  opts: {
    backgroundColor: '#f5f5f5', // "whitesmoke"
    width: WIDTH,
    height: HEIGHT,
    minWidth: WIDTH,
    minHeight: HEIGHT,
    icon: applogo.getPath()
  }
};


/**
 * Screen IPC handlers
 */

async function openWindowHandler() {
  const screen = ScreenManager.createScreen( IPCRouting.Main._ID, CONFIG.url, CONFIG.opts );
  screen.handle.setMenu( DefaultMenuTemplate );

  // the `setMenu` function above doesn't work on
  // osx so we'll have to accomodate for that
  if( is.osx() ) {
    Menu.setApplicationMenu( DefaultMenuTemplate );
  }
}


async function getAppLogoHandler( evt: IpcMainEvent, request: IpcRequest<any> ) {
  evt.sender.send(
    request.responsechannel,
    JSON.stringify({ logo: applogo.getBase64() })
  );
}


export default () => {
  ipcMain.on( IPCRouting.Main.OPEN, openWindowHandler );
  ipcMain.on( IPCRouting.Main.GET_APP_LOGO, getAppLogoHandler );
};
