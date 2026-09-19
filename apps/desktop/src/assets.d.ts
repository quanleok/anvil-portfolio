// Vite asset imports — declare types for the static file formats we use.

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.png" {
  const url: string;
  export default url;
}
declare module "*.jpg" {
  const url: string;
  export default url;
}
declare module "*.jpeg" {
  const url: string;
  export default url;
}
declare module "*.webp" {
  const url: string;
  export default url;
}
declare module "*.svg" {
  const url: string;
  export default url;
}
declare module "*.gif" {
  const url: string;
  export default url;
}
