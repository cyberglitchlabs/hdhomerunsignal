import { ListItemIcon, ListItemText, Menu, MenuItem } from '@mui/material';
import { ContentCopy as CopyIcon } from '@mui/icons-material';
import axios from 'axios';
import { streamFrequency } from '../../utils/channels';
import { streamUrl } from '../../utils/streamUrl';

// Right-click menu on a program's Watch button. `contextMenu` is
// { mouseX, mouseY, program }, or null while the menu is closed.
export default function StreamContextMenu({ contextMenu, onClose, tunerStatus, region, selectedDevice }) {
  // The menu closes whether or not the copy works
  const copyStreamUrl = async () => {
    try {
      const freq = streamFrequency(tunerStatus?.channel, region);
      if (contextMenu?.program && freq) {
        const response = await axios.get(
          streamUrl(selectedDevice, 'url', { ch: freq, program: contextMenu.program.programNum })
        );
        await navigator.clipboard.writeText(response.data.url);
      }
    } catch (error) {
      console.error('Failed to copy stream URL:', error);
    } finally {
      onClose();
    }
  };

  return (
    <Menu
      open={contextMenu !== null}
      onClose={onClose}
      anchorReference="anchorPosition"
      anchorPosition={
        contextMenu !== null
          ? { top: contextMenu.mouseY, left: contextMenu.mouseX }
          : undefined
      }
    >
      <MenuItem onClick={copyStreamUrl}>
        <ListItemIcon>
          <CopyIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Copy Stream URL</ListItemText>
      </MenuItem>
    </Menu>
  );
}
