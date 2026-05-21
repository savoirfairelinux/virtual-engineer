import { encryptToken } from "../utils/encryption.js";

export interface ProviderAuthDeviceStartResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface ProviderAuthRedirectStartInput {
  redirectUri: string;
  state?: string | undefined;
  codeChallenge?: string | undefined;
  codeChallengeMethod?: string | undefined;
}

export interface ProviderAuthRedirectStartResult {
  authorizationUrl: string;
}

export type ProviderAuthHandlerStartInput = ProviderAuthRedirectStartInput;

export type ProviderAuthHandlerStartResult =
  | ProviderAuthDeviceStartResult
  | ProviderAuthRedirectStartResult;

export interface ProviderAuthDeviceCompleteInput {
  deviceCode: string;
}

export interface ProviderAuthRedirectCompleteInput {
  code: string;
  redirectUri: string;
  state?: string | undefined;
  codeVerifier?: string | undefined;
}

export type ProviderAuthHandlerCompleteInput =
  | ProviderAuthDeviceCompleteInput
  | ProviderAuthRedirectCompleteInput;

export interface ProviderAuthHandlerCompleteResult {
  token: string;
}

export interface DeviceProviderAuthHandler {
  kind: "device";
  start(): Promise<ProviderAuthDeviceStartResult>;
  complete(input: ProviderAuthDeviceCompleteInput): Promise<ProviderAuthHandlerCompleteResult>;
}

export interface RedirectProviderAuthHandler {
  kind: "redirect";
  start(input: ProviderAuthRedirectStartInput): Promise<ProviderAuthRedirectStartResult>;
  complete(input: ProviderAuthRedirectCompleteInput): Promise<ProviderAuthHandlerCompleteResult>;
}

export type ProviderAuthHandler = DeviceProviderAuthHandler | RedirectProviderAuthHandler;

export interface CompletedProviderAuth {
  encryptedToken: string;
  isPlaintext: boolean;
}

export interface ProviderAuthService {
  startAuthFlow(
    handler: ProviderAuthHandler,
    input?: ProviderAuthHandlerStartInput
  ): Promise<ProviderAuthHandlerStartResult>;
  completeAuthFlow(
    handler: ProviderAuthHandler,
    input: ProviderAuthHandlerCompleteInput,
    options: { adminAuthSecret?: string | undefined }
  ): Promise<CompletedProviderAuth>;
}

export interface ProviderAuthServiceDependencies {
  encryptTokenFn?: ((token: string, adminAuthSecret: string | undefined) => string) | undefined;
}

export class DefaultProviderAuthService implements ProviderAuthService {
  private readonly encryptTokenFn: (token: string, adminAuthSecret: string | undefined) => string;

  constructor(deps: ProviderAuthServiceDependencies = {}) {
    this.encryptTokenFn = deps.encryptTokenFn ?? encryptToken;
  }

  async startAuthFlow(
    handler: ProviderAuthHandler,
    input?: ProviderAuthHandlerStartInput
  ): Promise<ProviderAuthHandlerStartResult> {
    switch (handler.kind) {
      case "device":
        return handler.start();
      case "redirect": {
        if (!input?.redirectUri) {
          throw new Error("redirectUri is required");
        }
        return handler.start({
          redirectUri: input.redirectUri,
          ...(input.state !== undefined ? { state: input.state } : {}),
          ...(input.codeChallenge !== undefined ? { codeChallenge: input.codeChallenge } : {}),
          ...(input.codeChallengeMethod !== undefined
            ? { codeChallengeMethod: input.codeChallengeMethod }
            : {}),
        });
      }
    }
  }

  async completeAuthFlow(
    handler: ProviderAuthHandler,
    input: ProviderAuthHandlerCompleteInput,
    options: { adminAuthSecret?: string | undefined }
  ): Promise<CompletedProviderAuth> {
    switch (handler.kind) {
      case "device": {
        if (!("deviceCode" in input)) {
          throw new Error("deviceCode is required");
        }
        const { token } = await handler.complete(input);
        const encryptedToken = this.encryptTokenFn(token, options.adminAuthSecret);
        return {
          encryptedToken,
          isPlaintext: !options.adminAuthSecret,
        };
      }
      case "redirect": {
        if (!("code" in input)) {
          throw new Error("authorization code is required");
        }
        if (!("redirectUri" in input) || typeof input.redirectUri !== "string" || !input.redirectUri) {
          throw new Error("redirectUri is required");
        }
        const { token } = await handler.complete(input);
        const encryptedToken = this.encryptTokenFn(token, options.adminAuthSecret);
        return {
          encryptedToken,
          isPlaintext: !options.adminAuthSecret,
        };
      }
    }
  }
}

export const defaultProviderAuthService: ProviderAuthService = new DefaultProviderAuthService();