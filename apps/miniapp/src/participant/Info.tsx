import type { AnnouncementView, InfoResponse } from '@sof/shared';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { IconBook2, IconPinnedFilled, IconSpeakerphone } from '@tabler/icons-react';
import { Markdown } from '../lib/markdown.tsx';
import { local, session } from '../lib/storage.ts';
import { formatDateTime } from '../lib/time.ts';
import { openExternal } from '../telegram/actions.ts';
import { Card, EmptyState, ErrorState, Segmented, Spinner } from '../ui/kit.tsx';
import { Page } from '../ui/Page.tsx';
import { participantApi, useMeData } from './api.ts';

const INFO_CACHE = 'sof:info';

const infoQuery = queryOptions({
  queryKey: ['info'] as const,
  queryFn: async () => {
    const data = await participantApi.info();
    local.setJSON(INFO_CACHE, { at: Date.now(), data });
    return data;
  },
  staleTime: 5 * 60_000,
  initialData: () => local.getJSON<{ at: number; data: InfoResponse }>(INFO_CACHE)?.data,
  initialDataUpdatedAt: () => local.getJSON<{ at: number; data: InfoResponse }>(INFO_CACHE)?.at,
});

function useLinkHandler() {
  const [, navigate] = useLocation();
  return (href: string) => (href.startsWith('/') ? navigate(href) : openExternal(href));
}

function sortAnnouncements(list: AnnouncementView[]): AnnouncementView[] {
  return [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt));
}

type Tab = 'pages' | 'news';

export default function Info() {
  const me = useMeData();
  const q = useQuery(infoQuery);
  const [, navigate] = useLocation();
  const onLink = useLinkHandler();
  const [tab, setTab] = useState<Tab>(() => (session.get('sof:info-tab') === 'news' ? 'news' : 'pages'));
  const announcements = useMemo(() => sortAnnouncements(q.data?.announcements ?? []), [q.data]);
  const pages = useMemo(() => [...(q.data?.pages ?? [])].sort((a, b) => a.sort - b.sort), [q.data]);

  const choose = (t: Tab) => {
    setTab(t);
    session.set('sof:info-tab', t);
  };

  if (!q.data) {
    return (
      <Page title="О конференции" back="/">
        {q.isPending ? (
          <div className="flex justify-center py-16">
            <Spinner className="size-9 text-btn" />
          </div>
        ) : (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        )}
      </Page>
    );
  }

  return (
    <Page title="О конференции" back="/">
      <Segmented
        className="mb-4"
        value={tab}
        onChange={choose}
        options={[
          { value: 'pages', label: 'Полезное' },
          { value: 'news', label: `Новости${announcements.length ? ` (${announcements.length})` : ''}` },
        ]}
      />

      {tab === 'pages' &&
        (pages.length === 0 ? (
          <EmptyState icon={IconBook2} hue="teal" title="Информации пока нет">
            Здесь появится, как добраться и что взять с собой.
          </EmptyState>
        ) : (
          <div className="overflow-hidden rounded-2xl bg-section">
            {pages.map((p) => (
              <button
                key={p.slug}
                type="button"
                onClick={() => navigate(`/info/${encodeURIComponent(p.slug)}`)}
                className="flex min-h-14 w-full items-center justify-between gap-3 border-b border-line px-4 py-3 text-left last:border-b-0 active:opacity-70"
              >
                <span className="text-[16px] font-medium leading-snug">{p.title}</span>
                <span className="text-xl text-hint">›</span>
              </button>
            ))}
          </div>
        ))}

      {tab === 'news' &&
        (announcements.length === 0 ? (
          <EmptyState icon={IconSpeakerphone} hue="orange" title="Новостей пока нет" />
        ) : (
          announcements.map((a) => (
            <Card key={a.id} className="mb-3">
              <div className="mb-1 flex items-start justify-between gap-2">
                <h2 className="text-[17px] font-bold leading-snug">
                  {a.pinned && <IconPinnedFilled size={16} aria-label="Закреплено" className="mr-1 inline-block align-[-1px] text-accent" />}
                  {a.title}
                </h2>
              </div>
              <p className="mb-2 text-[13px] text-hint">{formatDateTime(a.createdAt, me.event.timezone)}</p>
              <Markdown source={a.bodyMd} onLink={onLink} className="text-[15px]" />
            </Card>
          ))
        ))}
    </Page>
  );
}

export function InfoPageScreen({ slug }: { slug: string }) {
  const q = useQuery(infoQuery);
  const onLink = useLinkHandler();
  const page = q.data?.pages.find((p) => p.slug === decodeURIComponent(slug));

  if (!q.data) {
    return (
      <Page back="/info">
        {q.isPending ? (
          <div className="flex justify-center py-16">
            <Spinner className="size-9 text-btn" />
          </div>
        ) : (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        )}
      </Page>
    );
  }
  if (!page) {
    return (
      <Page title="Не нашли страницу" back="/info">
        <p className="text-subtle">Возможно, её убрали или переименовали.</p>
      </Page>
    );
  }
  return (
    <Page title={page.title} back="/info">
      <Card>
        <Markdown source={page.bodyMd} onLink={onLink} className="text-[16px]" />
      </Card>
    </Page>
  );
}
