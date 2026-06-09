/// <reference types="vite/client" />

declare module "*.png" {
  const url: string;
  export default url;
}
