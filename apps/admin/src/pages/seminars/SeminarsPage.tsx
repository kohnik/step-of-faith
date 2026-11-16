import { Button, Card, Stack } from '@mantine/core';
import type { SeminarBlockView } from '@sof/shared';
import { IconPlus, IconSchool } from '@tabler/icons-react';
import { useState } from 'react';
import { useSeminars, useSeminarsSummary } from '../../api/seminars.ts';
import { useIsMobile } from '../../components/AppModal.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { BlockSkeleton, EmptyBlock, ErrorState } from '../../components/states.tsx';
import { BlockModal, PlanCard, SeminarBlockPanel, TopicsCard } from './SeminarBlockPanel.tsx';

export default function SeminarsPage() {
  const seminars = useSeminars();
  const summary = useSeminarsSummary();
  const mobile = useIsMobile();
  const [modal, setModal] = useState<{ opened: boolean; block: SeminarBlockView | null; key: number }>({ opened: false, block: null, key: 0 });
  const open = (block: SeminarBlockView | null) => setModal((m) => ({ opened: true, block, key: m.key + 1 }));
  const count = seminars.data?.length ?? 0;
  return (
    <Stack gap={0}>
      <PageHeader
        title="Семинары"
        description="Люди выбирают темы, распределение раскладывает их по потокам и залам. Проверьте и опубликуйте."
        actions={
          <Button leftSection={<IconPlus size={16} />} onClick={() => open(null)}>
            Новый поток
          </Button>
        }
      />
      {seminars.isPending || summary.isPending ? (
        <BlockSkeleton />
      ) : seminars.isError ? (
        <ErrorState error={seminars.error} onRetry={() => void seminars.refetch()} />
      ) : summary.isError ? (
        <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
      ) : count === 0 ? (
        <EmptyBlock
          icon={<IconSchool size={28} />}
          title="Потоков семинаров пока нет"
          description="Создайте поток («Семинары: 1-ый поток», 15:30) и отметьте свободные залы, потом добавьте темы."
        />
      ) : (
        <Stack gap="md">
          <PlanCard summary={summary.data} blocks={seminars.data} />
          <TopicsCard summary={summary.data} />
          {seminars.data.map((b) => (
            <Card key={b.id} withBorder radius="md" p="md">
              <SeminarBlockPanel block={b} compact={mobile} onSettings={() => open(b)} />
            </Card>
          ))}
        </Stack>
      )}
      <BlockModal
        key={modal.key}
        block={modal.block}
        suggestedTitle={`Семинары: ${count + 1}-й поток`}
        opened={modal.opened}
        onClose={() => setModal((m) => ({ ...m, opened: false }))}
      />
    </Stack>
  );
}
