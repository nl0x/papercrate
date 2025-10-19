import React from 'react';

export const AppShellContext = React.createContext(null);

export const useAppShell = () => {
  const context = React.useContext(AppShellContext);
  if (!context) {
    throw new Error('AppShellContext not found. Ensure routes are nested under AppLayout.');
  }
  return context;
};

