import { Badge, Group, type BadgeProps } from '@mantine/core';
import {
  DEFAULT_TIERS,
  MIN_AGE,
  activityKindLabel,
  CATEGORY_LABELS,
  PAYMENT_STATUS_LABELS,
  ROLE_LABELS,
  braceletOf,
  tierShort,
  type Bracelet,
  type ActivityStatus,
  type Category,
  type ParticipantStatus,
  type PaymentStatus,
  type Role,
  type Tier,
  type TiersConfig,
} from '@sof/shared';
import {
  activityKindColor,
  ACTIVITY_STATUS_COLORS,
  ACTIVITY_STATUS_LABELS,
  CATEGORY_COLORS,
  PARTICIPANT_STATUS_LABELS,
  PAYMENT_STATUS_COLORS,
  ROLE_COLORS,
  scanOutcomeColor,
  scanOutcomeLabel,
} from '../lib/labels.ts';

type Size = BadgeProps['size'];

export function PaymentBadge({ status, size = 'sm' }: { status: PaymentStatus; size?: Size }) {
  return (
    <Badge color={PAYMENT_STATUS_COLORS[status]} size={size}>
      {PAYMENT_STATUS_LABELS[status]}
    </Badge>
  );
}

/** Вариант участия: цвет и подпись из настроек - такие же, как в Mini App и на экране сканера; с завтраком - «+ завтрак». */
export function TierBadge({
  tier,
  tiers,
  breakfast,
  size = 'sm',
}: {
  tier: Tier | null;
  tiers?: TiersConfig;
  breakfast?: boolean;
  size?: Size;
}) {
  if (!tier) return null;
  const cfg = (tiers ?? DEFAULT_TIERS)[tier] as TiersConfig[Tier] | undefined;
  if (!cfg) return null;
  return (
    <Badge color={cfg.color} variant="filled" autoContrast size={size} style={{ textTransform: 'none' }}>
      {tierShort(cfg, breakfast)}
    </Badge>
  );
}

/** Браслет на входе: чёрный - с питанием (обед и ужин), белый - без питания. */
export function BraceletBadge({ bracelet, size = 'sm' }: { bracelet: Bracelet | null; size?: Size }) {
  if (!bracelet) return null;
  return bracelet === 'black' ? (
    <Badge color="dark.9" variant="filled" size={size} style={{ textTransform: 'none', background: '#000', color: '#fff' }}>
      чёрный браслет
    </Badge>
  ) : (
    <Badge variant="outline" size={size} style={{ textTransform: 'none', background: '#fff', color: '#000', borderColor: 'rgba(0,0,0,.3)' }}>
      белый браслет
    </Badge>
  );
}

/** Браслет по варианту участия (по настройкам «Варианты участия»). */
export function TierBracelet({ tier, tiers, size = 'sm' }: { tier: Tier | null; tiers?: TiersConfig; size?: Size }) {
  return <BraceletBadge bracelet={braceletOf(tiers, tier)} size={size} />;
}

export function Under16Badge({ size = 'sm' }: { size?: Size }) {
  return (
    <Badge color="orange" variant="outline" size={size}>
      до {MIN_AGE}
    </Badge>
  );
}

export function CategoryBadge({ category, size = 'sm' }: { category: Category; size?: Size }) {
  return (
    <Badge color={CATEGORY_COLORS[category]} size={size} variant="outline">
      {CATEGORY_LABELS[category]}
    </Badge>
  );
}

export function ParticipantStatusBadge({ status, size = 'sm' }: { status: ParticipantStatus; size?: Size }) {
  return (
    <Badge color={status === 'active' ? 'green' : 'gray'} size={size} variant={status === 'active' ? 'light' : 'filled'}>
      {PARTICIPANT_STATUS_LABELS[status]}
    </Badge>
  );
}

export function RoleBadges({ roles, size = 'sm' }: { roles: readonly Role[]; size?: Size }) {
  if (roles.length === 0) {
    return (
      <Badge color="gray" size={size} variant="outline">
        без роли
      </Badge>
    );
  }
  return (
    <Group gap={4} wrap="wrap">
      {roles.map((role) => (
        <Badge key={role} color={ROLE_COLORS[role] ?? 'gray'} size={size}>
          {ROLE_LABELS[role]}
        </Badge>
      ))}
    </Group>
  );
}

export function OutcomeBadge({ outcome, size = 'sm' }: { outcome: string; size?: Size }) {
  return (
    <Badge color={scanOutcomeColor(outcome)} size={size}>
      {scanOutcomeLabel(outcome)}
    </Badge>
  );
}

export function ActivityStatusBadge({ status, size = 'sm' }: { status: ActivityStatus; size?: Size }) {
  return (
    <Badge color={ACTIVITY_STATUS_COLORS[status]} size={size} variant={status === 'published' ? 'light' : 'outline'}>
      {ACTIVITY_STATUS_LABELS[status]}
    </Badge>
  );
}

export function ActivityKindBadge({ kind, size = 'sm' }: { kind: string; size?: Size }) {
  return (
    <Badge color={activityKindColor(kind)} size={size} variant="dot">
      {activityKindLabel(kind)}
    </Badge>
  );
}
