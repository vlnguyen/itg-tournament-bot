import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import { router } from './router';
import '@mantine/core/styles.css';

const queryClient = new QueryClient();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root element is missing from index.html');

createRoot(rootElement).render(
  <StrictMode>
    <HelmetProvider>
      <MantineProvider defaultColorScheme="dark">
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </MantineProvider>
    </HelmetProvider>
  </StrictMode>,
);
