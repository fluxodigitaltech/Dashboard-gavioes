/// <reference types="vite/client" />

interface ImportMetaEnv {
  // NocoDB
  readonly VITE_NOCODB_TOKEN: string;

  // Meta Marketing API
  readonly VITE_META_ACCESS_TOKEN: string;

  // W12 Evo — one token per unit (idBranch)
  readonly VITE_EVO_TOKEN_ALTINO_ARANTES: string;
  readonly VITE_EVO_TOKEN_SAUDE: string;
  readonly VITE_EVO_TOKEN_PARQUE_NACOES: string;
  readonly VITE_EVO_TOKEN_ALTO_IPIRANGA: string;
  readonly VITE_EVO_TOKEN_JARDINS: string;
  readonly VITE_EVO_TOKEN_BELENZINHO: string;
  readonly VITE_EVO_TOKEN_CAMPESTRE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
