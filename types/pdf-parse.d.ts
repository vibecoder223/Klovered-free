declare module "pdf-parse/lib/pdf-parse.js" {
  const fn: (buffer: Buffer) => Promise<{ text: string; numpages: number; info: unknown; metadata: unknown }>;
  export default fn;
}
