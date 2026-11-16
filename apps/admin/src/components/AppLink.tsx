import { Anchor, type AnchorProps } from '@mantine/core';
import type { MouseEvent, ReactNode } from 'react';
import { useLocation } from 'wouter';

/**
 * Пропсы для внутренней ссылки: обычный `href` (работают «открыть в новой вкладке»
 * и средняя кнопка), а простой клик - навигация без перезагрузки.
 */
export function useInternalLink(href: string, onNavigate?: () => void) {
  const [, navigate] = useLocation();
  return {
    href,
    onClick: (event: MouseEvent<HTMLElement>) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      navigate(href);
      onNavigate?.();
    },
  };
}

export function AppLink({ href, children, ...rest }: AnchorProps & { href: string; children: ReactNode }) {
  const link = useInternalLink(href);
  return (
    <Anchor {...rest} href={link.href} onClick={link.onClick}>
      {children}
    </Anchor>
  );
}
