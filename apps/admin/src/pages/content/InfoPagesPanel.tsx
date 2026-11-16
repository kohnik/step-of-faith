import {
  Badge,
  Button,
  Card,
  Grid,
  Group,
  NavLink,
  NumberInput,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { infoPageInputSchema, type InfoPageInput, type InfoPageView } from '@sof/shared';
import { IconArticle, IconDeviceFloppy, IconEyeOff, IconPlus, IconTrash } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useDeletePage, useSavePage } from '../../api/content.ts';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { EmptyBlock } from '../../components/states.tsx';
import { notifySuccess } from '../../lib/notify.tsx';
import { numberOrNull, schemaErrors } from '../../lib/validation.ts';
import { MarkdownEditor } from './MarkdownEditor.tsx';

const NEW = '__new__';
const SLUG_RE = /^[a-z0-9-]{1,40}$/;

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** «Как добраться» → `kak-dobratsya`. */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .split('')
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

export function InfoPagesPanel({ pages }: { pages: InfoPageView[] }) {
  const confirm = useConfirm();
  const sorted = [...pages].sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title, 'ru'));
  const [selected, setSelected] = useState<string | null>(sorted[0]?.slug ?? null);
  const [dirty, setDirty] = useState(false);

  const current = selected && selected !== NEW ? (pages.find((p) => p.slug === selected) ?? null) : null;
  const effective = selected === NEW ? NEW : current ? current.slug : null;

  const select = async (slug: string) => {
    if (slug === effective) return;
    if (dirty) {
      const ok = await confirm({
        title: 'Есть несохранённые изменения',
        message: 'Перейти к другой странице без сохранения?',
        confirmLabel: 'Перейти без сохранения',
        danger: true,
      });
      if (!ok) return;
    }
    setDirty(false);
    setSelected(slug);
  };

  return (
    <Grid gap="lg">
      <Grid.Col span={{ base: 12, md: 4, xl: 3 }}>
        <Card padding="xs">
          <Stack gap={4}>
            <Button variant="light" leftSection={<IconPlus size={16} />} onClick={() => void select(NEW)} mb={4}>
              Новая страница
            </Button>
            {sorted.length === 0 && (
              <Text size="sm" c="dimmed" p="sm">
                Страниц пока нет.
              </Text>
            )}
            {sorted.map((p) => (
              <NavLink
                key={p.slug}
                active={effective === p.slug}
                onClick={() => void select(p.slug)}
                label={p.title}
                description={`/${p.slug} · порядок ${p.sort}`}
                leftSection={<IconArticle size={16} />}
                rightSection={
                  p.published ? undefined : (
                    <Badge size="xs" color="gray" variant="outline" leftSection={<IconEyeOff size={10} />}>
                      скрыта
                    </Badge>
                  )
                }
                variant="light"
                style={{ borderRadius: 'var(--mantine-radius-md)' }}
                component="button"
              />
            ))}
          </Stack>
        </Card>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 8, xl: 9 }}>
        {effective ? (
          <PageEditor
            key={effective}
            page={current}
            existingSlugs={pages.map((p) => p.slug)}
            nextSort={(sorted[sorted.length - 1]?.sort ?? 0) + 10}
            onDirtyChange={setDirty}
            onSaved={(slug) => {
              setDirty(false);
              setSelected(slug);
            }}
            onDeleted={() => {
              setDirty(false);
              setSelected(sorted.find((p) => p.slug !== effective)?.slug ?? null);
            }}
          />
        ) : (
          <Card>
            <EmptyBlock
              icon={<IconArticle size={28} />}
              title="Выберите страницу"
              description="Или создайте новую - например, «Как добраться», «Что взять с собой», «Правила конференции»."
              action={
                <Button leftSection={<IconPlus size={16} />} onClick={() => void select(NEW)}>
                  Новая страница
                </Button>
              }
            />
          </Card>
        )}
      </Grid.Col>
    </Grid>
  );
}

interface Values {
  slug: string;
  title: string;
  sort: number | string;
  published: boolean;
  bodyMd: string;
}

function PageEditor({
  page,
  existingSlugs,
  nextSort,
  onDirtyChange,
  onSaved,
  onDeleted,
}: {
  page: InfoPageView | null;
  existingSlugs: string[];
  nextSort: number;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (slug: string) => void;
  onDeleted: () => void;
}) {
  const confirm = useConfirm();
  const save = useSavePage();
  const remove = useDeletePage();
  const isNew = page === null;
  const [slugTouched, setSlugTouched] = useState(!isNew);

  const toInput = (v: Values): InfoPageInput => ({
    title: v.title.trim(),
    bodyMd: v.bodyMd,
    sort: numberOrNull(v.sort) ?? 0,
    published: v.published,
  });

  const form = useForm<Values>({
    mode: 'controlled',
    initialValues: page
      ? { slug: page.slug, title: page.title, sort: page.sort, published: page.published, bodyMd: page.bodyMd }
      : { slug: '', title: '', sort: nextSort, published: true, bodyMd: '' },
    validate: (v) => {
      const errors = schemaErrors(infoPageInputSchema, toInput(v));
      if (isNew) {
        if (!SLUG_RE.test(v.slug)) errors.slug = 'Латиница в нижнем регистре, цифры и дефис, до 40 символов';
        else if (existingSlugs.includes(v.slug)) errors.slug = 'Страница с таким адресом уже есть';
      }
      return errors;
    },
  });

  const dirty = form.isDirty();
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const submit = form.onSubmit((values) => {
    const slug = isNew ? values.slug : page.slug;
    save.mutate(
      { slug, input: toInput(values) },
      {
        onSuccess: (saved) => {
          notifySuccess(isNew ? 'Страница создана' : 'Страница сохранена', saved.title);
          form.resetDirty();
          onSaved(saved.slug);
        },
      },
    );
  });

  const doDelete = async () => {
    if (!page) return;
    const ok = await confirm({
      title: `Удалить страницу «${page.title}»?`,
      message: 'Участники перестанут её видеть. Восстановить можно только создав заново.',
      confirmLabel: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    remove.mutate(page.slug, {
      onSuccess: () => {
        notifySuccess('Страница удалена');
        onDeleted();
      },
    });
  };

  return (
    <Card>
      <form onSubmit={submit} noValidate>
        <Stack gap="md">
          <Group justify="space-between" gap="sm">
            <Text fw={700} size="lg">
              {isNew ? 'Новая страница' : page.title}
            </Text>
            {!isNew && (
              <Badge variant="light" color={page.published ? 'green' : 'gray'}>
                {page.published ? 'опубликована' : 'скрыта'}
              </Badge>
            )}
          </Group>
          <Grid gap="sm">
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <TextInput
                label="Заголовок"
                required
                data-autofocus
                {...form.getInputProps('title')}
                onChange={(e) => {
                  const title = e.currentTarget.value;
                  form.setFieldValue('title', title);
                  if (isNew && !slugTouched) form.setFieldValue('slug', slugify(title));
                }}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 3 }}>
              <TextInput
                label="Адрес (slug)"
                description={isNew ? 'латиница, цифры, дефис' : 'не меняется'}
                disabled={!isNew}
                leftSection={<Text size="sm" c="dimmed">/</Text>}
                {...form.getInputProps('slug')}
                onChange={(e) => {
                  setSlugTouched(true);
                  form.setFieldValue('slug', e.currentTarget.value.toLowerCase().replace(/\s+/g, '-'));
                }}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 6, sm: 3 }}>
              <NumberInput label="Порядок" description="меньше - выше" allowDecimal={false} {...form.getInputProps('sort')} />
            </Grid.Col>
          </Grid>
          <Switch label="Опубликована (видна участникам)" {...form.getInputProps('published', { type: 'checkbox' })} />
          <MarkdownEditor
            label="Текст"
            value={form.values.bodyMd}
            onChange={(v) => form.setFieldValue('bodyMd', v)}
            error={form.errors.bodyMd}
            maxLength={20000}
            placeholder={'## Как добраться\n\nОт вокзала - автобус **№ 12** до остановки «Конференц-центр».'}
          />
          <Group justify="space-between" gap="sm">
            {!isNew ? (
              <Button variant="subtle" color="red" leftSection={<IconTrash size={16} />} onClick={() => void doDelete()} loading={remove.isPending}>
                Удалить
              </Button>
            ) : (
              <span />
            )}
            <Group gap="sm">
              <Button variant="default" disabled={!dirty} onClick={() => form.reset()}>
                Отменить правки
              </Button>
              <Button type="submit" leftSection={<IconDeviceFloppy size={16} />} loading={save.isPending} disabled={!isNew && !dirty}>
                {isNew ? 'Создать' : 'Сохранить'}
              </Button>
            </Group>
          </Group>
        </Stack>
      </form>
    </Card>
  );
}
