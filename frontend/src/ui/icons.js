import {
  IconChevronRight as TablerChevronRight,
  IconDownload as TablerDownload,
  IconFolderFilled,
  IconPencil,
  IconTagFilled,
  IconUserFilled,
  IconTrash,
  IconLayoutList,
  IconLayoutGrid,
} from '@tabler/icons-react';

const composeClassName = (base, extra) => (extra ? `${base} ${extra}` : base);

export const ChevronIcon = ({ className, size = '1em', stroke = 1.6, ...rest }) => (
  <TablerChevronRight
    className={composeClassName('icon', className)}
    size={size}
    stroke={stroke}
    {...rest}
  />
);

export const TrashIcon = ({ className, size = '1em', stroke = 1.6, ...rest }) => (
  <IconTrash
    className={composeClassName('icon', className)}
    size={size}
    stroke={stroke}
    {...rest}
  />
);

export const EditIcon = ({ className, size = '1em', stroke = 1.6, ...rest }) => (
  <IconPencil
    className={composeClassName('icon', className)}
    size={size}
    stroke={stroke}
    {...rest}
  />
);

export const FolderIcon = ({ className, size = '1em', stroke = 0, ...rest }) => (
  <IconFolderFilled
    className={composeClassName('icon icon--fill', className)}
    size={size}
    stroke={stroke}
    {...rest}
  />
);

export const TagIcon = ({ className, size = '1em', stroke = 0, ...rest }) => (
  <IconTagFilled
    className={composeClassName('icon icon--fill', className)}
    size={size}
    stroke={stroke}
    {...rest}
  />
);

export const CorrespondentIcon = ({ className, size = '1em', stroke = 0, ...rest }) => (
  <IconUserFilled
    className={composeClassName('icon icon--fill', className)}
    size={size}
    stroke={stroke}
    {...rest}
  />
);

export const DownloadIcon = ({ className, size = '1em', stroke = 1.6, ...rest }) => (
  <TablerDownload
    className={composeClassName('icon', className)}
    size={size}
    stroke={stroke}
    {...rest}
  />
);

export const ViewListIcon = ({ className, size = '1em', stroke = 1.6, ...rest }) => (
  <IconLayoutList
    className={composeClassName('icon', className)}
    size={size}
    stroke={stroke}
    {...rest}
  />
);

export const ViewGridIcon = ({ className, size = '1em', stroke = 1.6, ...rest }) => (
  <IconLayoutGrid
    className={composeClassName('icon', className)}
    size={size}
    stroke={stroke}
    {...rest}
  />
);

export default {
  ChevronIcon,
  TrashIcon,
  EditIcon,
  FolderIcon,
  TagIcon,
  CorrespondentIcon,
  DownloadIcon,
  ViewListIcon,
  ViewGridIcon,
};
