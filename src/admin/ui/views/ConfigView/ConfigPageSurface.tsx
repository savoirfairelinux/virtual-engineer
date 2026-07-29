import { createContext, useContext } from "react";

const ConfigPageSurfaceContext = createContext(false);

export function ConfigPageSurface({ children }: { children: React.ReactNode }) {
  return (
    <ConfigPageSurfaceContext.Provider value>
      {children}
    </ConfigPageSurfaceContext.Provider>
  );
}

export function useConfigPageSurface(): boolean {
  return useContext(ConfigPageSurfaceContext);
}