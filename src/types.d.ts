// src/types.d.ts
declare module 'api' {
  const joplin: any;
  export default joplin;
}
declare module 'api/types' {
  export enum ContentScriptType {
    CodeMirrorPlugin = 1
  }
  export enum MenuItemLocation {
    Tools = 1
  }
}