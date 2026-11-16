import '@mantine/core/styles.css';
import '@mantine/dates/styles.css';
import '@mantine/notifications/styles.css';
import './styles.css';
import 'dayjs/locale/ru';

import { MantineProvider } from '@mantine/core';
import { DatesProvider } from '@mantine/dates';
import { Notifications } from '@mantine/notifications';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from './api/client.ts';
import { App } from './App.tsx';
import { notifyError } from './lib/notify.tsx';
import { theme } from './theme.ts';

const queryClient = new QueryClient({
  // Ошибки изменений показываем уведомлением с текстом сервера (кроме тех, что форма показывает сама).
  mutationCache: new MutationCache({
    onError: (error, _variables, _result, mutation) => {
      if (mutation.meta?.silent) return;
      if (error instanceof ApiError && error.status === 401) return; // уведём на вход
      notifyError(error);
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (count, error) => {
        if (error instanceof ApiError && error.status > 0 && error.status < 500) return false;
        return count < 2;
      },
    },
    mutations: { retry: false },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('Нет #root');

createRoot(root).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <DatesProvider settings={{ locale: 'ru', firstDayOfWeek: 1, weekendDays: [0, 6], consistentWeeks: true }}>
        <Notifications position="top-right" limit={4} zIndex={1000} />
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </DatesProvider>
    </MantineProvider>
  </StrictMode>,
);
