import { app, Menu } from 'electron';
import is from 'electron-is';


// enum items get offset by one on osx because
// that first item is reserved for the application name
// see: https://electronjs.org/docs/api/menu#main-menus-name
export const MenuItems = {
  APPNAME: 0,
  FILE: is.osx() ? 1 : 0,
  EDIT: is.osx() ? 2 : 1,
  VIEW: is.osx() ? 3 : 2,
  WINDOW: is.osx() ? 4 : 3,
  HELP: is.osx() ? 4 : 3
};


export const RawDefaultMenuTemplate: Record<string, any>[] = [
  {
    label: 'File',
    submenu: [
      { role: 'quit' }
    ]
  },
  {
    label: 'Edit',
    submenu: [],
  },
  {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forcereload' },
      { role: 'toggledevtools' }
    ]
  },
  {
    role: 'window',
    submenu: [
      { role: 'minimize' },
      { role: 'close' }
    ]
  },
  {
    role: 'help',
    submenu: [
      {
        label: 'Learn More',
        click() {
          require( 'electron' ).shell.openExternal( 'https://electronjs.org' );
        }
      }
    ]
  }
];


// osx-specific menu items
if( is.osx() ) {
  RawDefaultMenuTemplate.unshift({
    label: app.name,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideothers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ]
  });

  RawDefaultMenuTemplate[ MenuItems.WINDOW ].submenu = [
    { role: 'close' },
    { role: 'minimize' },
    { type: 'separator' },
    { role: 'front' }
  ];
}


// build the default menu template
let DefaultMenuTemplate = Menu.buildFromTemplate( RawDefaultMenuTemplate.filter( item => item !== null && item.submenu.length > 0 ) );


// production-specific menu alterations
if( is.production() ) {
  // on windows we hide the menu entirely
  if( is.windows() ) {
    DefaultMenuTemplate = Menu.buildFromTemplate( [] );
  }

  // on osx we show the application menu item
  if( is.osx() && is.production() ) {
    DefaultMenuTemplate = Menu.buildFromTemplate( [ RawDefaultMenuTemplate[ MenuItems.APPNAME ] ] );
  }
}


// finally, export the menu
export default DefaultMenuTemplate;
