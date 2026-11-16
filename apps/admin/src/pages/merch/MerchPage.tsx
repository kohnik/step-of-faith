import { Badge, Stack, Tabs } from '@mantine/core';
import { IconChartBar, IconCoins, IconPackage, IconSettings, IconShirt } from '@tabler/icons-react';
import { lazy, Suspense, useState } from 'react';
import { useMerchOrders } from '../../api/merch.ts';
import { PageHeader } from '../../components/PageHeader.tsx';
import { useCan } from '../../components/SessionProvider.tsx';
import { BlockSkeleton } from '../../components/states.tsx';

const ProductsPanel = lazy(() => import('./ProductsPanel.tsx'));
const OrdersPanel = lazy(() => import('./OrdersPanel.tsx'));
const StatsPanel = lazy(() => import('./StatsPanel.tsx'));
const SettingsPanel = lazy(() => import('./SettingsPanel.tsx'));

type Tab = 'products' | 'orders' | 'debts' | 'stats' | 'settings';

export default function MerchPage() {
  const can = useCan();
  const canCatalog = can('merch:stock');
  const canOrders = can('merch:sell');
  const canStats = can('merch:stats');
  // Из «Настроек» ведёт ссылка «?tab=settings», из сообщения бота о чеке - «?receipts=1» (заказы, фильтр «Чеки»).
  const [tab, setTab] = useState<Tab>(() => {
    const qs = new URLSearchParams(window.location.search);
    if (canOrders && qs.get('receipts')) return 'orders';
    return canCatalog && qs.get('tab') === 'settings' ? 'settings' : canCatalog ? 'products' : canOrders ? 'orders' : 'stats';
  });
  const orders = useMerchOrders(canOrders);
  const open = (orders.data ?? []).filter((o) => o.status === 'reserved' || o.status === 'paid').length;
  const owed = (orders.data ?? []).filter((o) => o.status === 'owed').length;

  return (
    <Stack gap="md">
      <PageHeader
        title="Мерч"
        description="Витрина в мини-приложении: вещи, цвета, размеры с остатками, фото и 3D-модели. Показ, бронь и оплату включают на вкладке «Настройки»."
      />
      <Tabs value={tab} onChange={(v) => v && setTab(v as Tab)}>
        <Tabs.List>
          {canCatalog && (
            <Tabs.Tab value="products" leftSection={<IconShirt size={16} />}>
              Товары
            </Tabs.Tab>
          )}
          {canOrders && (
            <Tabs.Tab
              value="orders"
              leftSection={<IconPackage size={16} />}
              rightSection={open ? <Badge size="xs" variant="filled" color="yellow">{open}</Badge> : undefined}
            >
              Заказы
            </Tabs.Tab>
          )}
          {canOrders && (
            <Tabs.Tab
              value="debts"
              leftSection={<IconCoins size={16} />}
              rightSection={owed ? <Badge size="xs" variant="filled" color="orange">{owed}</Badge> : undefined}
            >
              Должники
            </Tabs.Tab>
          )}
          {canStats && (
            <Tabs.Tab value="stats" leftSection={<IconChartBar size={16} />}>
              Статистика
            </Tabs.Tab>
          )}
          {canCatalog && (
            <Tabs.Tab value="settings" leftSection={<IconSettings size={16} />}>
              Настройки
            </Tabs.Tab>
          )}
        </Tabs.List>
      </Tabs>
      <Suspense fallback={<BlockSkeleton rows={4} height={120} />}>
        {tab === 'products' && canCatalog ? (
          <ProductsPanel />
        ) : tab === 'stats' && canStats ? (
          <StatsPanel />
        ) : tab === 'settings' && canCatalog ? (
          <SettingsPanel />
        ) : tab === 'debts' && canOrders ? (
          <OrdersPanel key="debts" debts />
        ) : canOrders ? (
          <OrdersPanel key="orders" />
        ) : null}
      </Suspense>
    </Stack>
  );
}
