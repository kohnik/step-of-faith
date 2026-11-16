import { Group, Modal, type ModalProps } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import type { ReactNode } from 'react';

/** Телефон: всё, что уже 48em (768px). */
export const MOBILE_QUERY = '(max-width: 48em)';

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY, false, { getInitialValueInEffect: false }) ?? false;
}

/**
 * Модалка админки. На компьютере - обычное окно по центру, на телефоне - во весь экран:
 * содержимое прокручивается, а кнопки из `<ModalActions>` прилипают к низу и всегда видны.
 */
export function AppModal({ fullScreen, transitionProps, ...props }: ModalProps) {
  const mobile = useIsMobile();
  return (
    <Modal
      {...props}
      fullScreen={mobile || fullScreen}
      transitionProps={mobile ? { transition: 'fade', duration: 150 } : transitionProps}
      data-sof-modal
    />
  );
}

/** Кнопки внизу модалки (последний элемент содержимого). */
export function ModalActions({ children, justify = 'flex-end' }: { children: ReactNode; justify?: 'flex-end' | 'space-between' }) {
  return (
    <div className="sof-modal-actions">
      <Group justify={justify} gap="sm">
        {children}
      </Group>
    </div>
  );
}
