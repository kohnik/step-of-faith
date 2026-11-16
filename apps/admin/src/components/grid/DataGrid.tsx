import { useComputedColorScheme } from '@mantine/core';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import { AgGridReact, type AgGridReactProps } from 'ag-grid-react';
import type { Ref } from 'react';
import { AG_GRID_LOCALE_RU } from './locale.ts';
import { gridThemeDark, gridThemeLight } from './theme.ts';

// Регистрация модулей один раз - этот файл грузится только вместе со страницами-таблицами.
ModuleRegistry.registerModules([AllCommunityModule]);

export const SELECTION_COLUMN_ID = 'ag-Grid-SelectionColumn';

export interface DataGridProps<T> extends AgGridReactProps<T> {
  /** Высота контейнера (у AG Grid должна быть явная высота). */
  height?: number | string;
  gridRef?: Ref<AgGridReact<T>>;
  /** Курсор-«рука» на строках (клик открывает карточку). */
  clickable?: boolean;
}

/** Обёртка AG Grid: тема под Mantine (светлая/тёмная), русская локаль, общие настройки. */
export function DataGrid<T>({ height = 560, gridRef, clickable, className, ...props }: DataGridProps<T>) {
  const scheme = useComputedColorScheme('light');
  return (
    <div className={['sof-grid', clickable ? 'sof-grid-clickable' : '', className ?? ''].join(' ')} style={{ height }}>
      <AgGridReact<T>
        ref={gridRef}
        theme={scheme === 'dark' ? gridThemeDark : gridThemeLight}
        localeText={AG_GRID_LOCALE_RU}
        loadThemeGoogleFonts={false}
        animateRows={false}
        enableCellTextSelection
        ensureDomOrder
        suppressDragLeaveHidesColumns
        // Поиск находит и по скрытым колонкам: код оплаты из комментария к переводу, телефон владельца.
        includeHiddenColumnsInQuickFilter
        tooltipShowDelay={400}
        {...props}
      />
    </div>
  );
}

/** Клик по строке, но не при выделении текста мышью. */
export function isTextSelectionClick(): boolean {
  const selection = window.getSelection();
  return !!selection && selection.toString().length > 0;
}
