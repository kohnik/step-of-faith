import { colorSchemeDark, colorSchemeLight, themeQuartz } from 'ag-grid-community';

/**
 * Тема AG Grid в цветах Mantine (Theming API). Две версии - светлая и тёмная,
 * DataGrid выбирает по текущей цветовой схеме. Шрифт - как у всего приложения
 * (без загрузки шрифтов с Google).
 */
const common = {
  fontFamily: 'inherit',
  fontSize: 13,
  headerFontSize: 12.5,
  headerFontWeight: 650,
  spacing: 7,
  borderRadius: 6,
  wrapperBorderRadius: 12,
  iconSize: 15,
  columnBorder: false,
  headerColumnBorder: false,
  cellHorizontalPaddingScale: 0.85,
} as const;

export const gridThemeLight = themeQuartz.withPart(colorSchemeLight).withParams({
  ...common,
  accentColor: 'var(--mantine-color-indigo-6)',
  backgroundColor: '#ffffff',
  foregroundColor: '#1a1b1e',
  borderColor: 'var(--mantine-color-gray-3)',
  headerBackgroundColor: 'var(--mantine-color-gray-0)',
  headerTextColor: 'var(--mantine-color-gray-7)',
  chromeBackgroundColor: 'var(--mantine-color-gray-0)',
  rowHoverColor: 'var(--mantine-color-indigo-0)',
  selectedRowBackgroundColor: 'var(--mantine-color-indigo-1)',
});

export const gridThemeDark = themeQuartz.withPart(colorSchemeDark).withParams({
  ...common,
  accentColor: 'var(--mantine-color-indigo-4)',
  backgroundColor: 'var(--mantine-color-dark-7)',
  foregroundColor: 'var(--mantine-color-dark-0)',
  borderColor: 'var(--mantine-color-dark-4)',
  headerBackgroundColor: 'var(--mantine-color-dark-6)',
  headerTextColor: 'var(--mantine-color-dark-1)',
  chromeBackgroundColor: 'var(--mantine-color-dark-6)',
  rowHoverColor: 'rgba(92, 124, 250, 0.10)',
  selectedRowBackgroundColor: 'rgba(92, 124, 250, 0.20)',
});
