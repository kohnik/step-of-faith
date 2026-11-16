import { Badge, Group, Stack, Tabs } from '@mantine/core';
import { IconArticle, IconSpeakerphone } from '@tabler/icons-react';
import { useState } from 'react';
import { useContent } from '../../api/content.ts';
import { PageHeader } from '../../components/PageHeader.tsx';
import { BlockSkeleton, ErrorState } from '../../components/states.tsx';
import { AnnouncementsPanel } from './AnnouncementsPanel.tsx';
import { InfoPagesPanel } from './InfoPagesPanel.tsx';

export default function ContentPage() {
  const content = useContent();
  const [tab, setTab] = useState<'pages' | 'announcements'>('pages');

  return (
    <Stack gap="md">
      <PageHeader
        title="Страницы и объявления"
        description="Полезные страницы (как добраться, что взять с собой, правила) и лента объявлений - всё это участники видят в мини-приложении."
      />
      <Tabs value={tab} onChange={(v) => v && setTab(v as 'pages' | 'announcements')}>
        <Tabs.List>
          <Tabs.Tab
            value="pages"
            leftSection={<IconArticle size={16} />}
            rightSection={content.data ? <Badge size="xs" variant="light" color="gray">{content.data.pages.length}</Badge> : undefined}
          >
            Инфо-страницы
          </Tabs.Tab>
          <Tabs.Tab
            value="announcements"
            leftSection={<IconSpeakerphone size={16} />}
            rightSection={
              content.data ? <Badge size="xs" variant="light" color="gray">{content.data.announcements.length}</Badge> : undefined
            }
          >
            Объявления
          </Tabs.Tab>
        </Tabs.List>
      </Tabs>
      {content.isPending ? (
        <Group align="flex-start" grow>
          <BlockSkeleton rows={5} height={44} />
          <BlockSkeleton rows={1} height={380} />
        </Group>
      ) : content.isError ? (
        <ErrorState error={content.error} onRetry={() => void content.refetch()} />
      ) : tab === 'pages' ? (
        <InfoPagesPanel pages={content.data.pages} />
      ) : (
        <AnnouncementsPanel announcements={content.data.announcements} />
      )}
    </Stack>
  );
}
