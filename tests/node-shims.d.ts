declare module 'node:assert/strict' {
  const assert: any;
  export default assert;
}

declare module 'node:test' {
  const test: any;
  export default test;
}

declare const require: {
  (id: string): any;
  cache: Record<string, unknown>;
  resolve(id: string): string;
};
