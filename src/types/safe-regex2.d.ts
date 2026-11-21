declare module 'safe-regex2' {
  function safeRegex(pattern: string | RegExp): boolean;
  export = safeRegex;
}
