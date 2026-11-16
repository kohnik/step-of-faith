import { Anchor, Text, type MantineSize } from '@mantine/core';
import { useParticipantDrawer } from './ParticipantDrawerProvider.tsx';

/** Имя участника; по клику открывается его карточка (если есть права). */
export function ParticipantLink({
  id,
  name,
  size = 'sm',
  fw,
}: {
  id: number | null | undefined;
  name: string | null | undefined;
  size?: MantineSize;
  fw?: number;
}) {
  const { openParticipant, canOpen } = useParticipantDrawer();
  if (!name) {
    return (
      <Text span c="dimmed" size={size}>
        -
      </Text>
    );
  }
  if (!id || !canOpen) {
    return (
      <Text span size={size} fw={fw}>
        {name}
      </Text>
    );
  }
  return (
    <Anchor
      component="button"
      type="button"
      size={size}
      fw={fw}
      ta="left"
      onClick={(e) => {
        e.stopPropagation();
        openParticipant(id);
      }}
    >
      {name}
    </Anchor>
  );
}
