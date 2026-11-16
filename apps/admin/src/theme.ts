import {
  ActionIcon,
  Badge,
  Button,
  Card,
  createTheme,
  Drawer,
  Input,
  Loader,
  Menu,
  Modal,
  Paper,
  SegmentedControl,
  Table,
  Tooltip,
} from '@mantine/core';

/** Системные шрифты - никаких внешних CDN. */
const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji"';

export const theme = createTheme({
  primaryColor: 'indigo',
  primaryShade: { light: 6, dark: 5 },
  defaultRadius: 'md',
  fontFamily: FONT_STACK,
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  headings: {
    fontFamily: FONT_STACK,
    fontWeight: '700',
  },
  cursorType: 'pointer',
  focusRing: 'auto',
  components: {
    // Подсказка - под полем: иначе поле с подсказкой съезжает ниже соседнего в том же ряду.
    InputWrapper: Input.Wrapper.extend({ defaultProps: { inputWrapperOrder: ['label', 'input', 'description', 'error'] } }),
    Button: Button.extend({ defaultProps: { radius: 'md' } }),
    ActionIcon: ActionIcon.extend({ defaultProps: { variant: 'subtle', color: 'gray' } }),
    Badge: Badge.extend({ defaultProps: { variant: 'light', radius: 'sm' } }),
    Card: Card.extend({ defaultProps: { withBorder: true, radius: 'lg', padding: 'lg' } }),
    Paper: Paper.extend({ defaultProps: { radius: 'lg' } }),
    // Модалки открываются и поверх карточки участника (Drawer, z-index 200).
    Modal: Modal.extend({
      defaultProps: { radius: 'lg', centered: true, zIndex: 300, overlayProps: { backgroundOpacity: 0.45, blur: 2 } },
    }),
    Drawer: Drawer.extend({ defaultProps: { zIndex: 200, overlayProps: { backgroundOpacity: 0.35, blur: 1 } } }),
    Tooltip: Tooltip.extend({ defaultProps: { withArrow: true, openDelay: 250 } }),
    Menu: Menu.extend({ defaultProps: { shadow: 'md', radius: 'md', withinPortal: true } }),
    Table: Table.extend({ defaultProps: { verticalSpacing: 'xs', highlightOnHover: true } }),
    SegmentedControl: SegmentedControl.extend({ defaultProps: { radius: 'md' } }),
    Loader: Loader.extend({ defaultProps: { type: 'dots' } }),
  },
});
