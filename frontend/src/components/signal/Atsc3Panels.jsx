import {
  Box,
  Chip,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography
} from '@mui/material';
import PanelCard from './PanelCard';

// The ATSC 3.0 details for the tuned channel: a banner, the PLP table and the
// L1 values. Each panel appears only once its data does.
export default function Atsc3Panels({ isAtsc3Channel, plpInfo, l1Info }) {
  return (
    <>
      {isAtsc3Channel && (
        <PanelCard>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <Chip
              label="ATSC 3.0 Channel Detected"
              color="success"
              variant="outlined"
              size="small"
              sx={{ fontWeight: 600 }}
            />
            <Typography variant="body2" sx={{ fontSize: '0.8rem', color: 'text.secondary' }}>
              NextGen TV signal with enhanced data available
            </Typography>
          </Box>
        </PanelCard>
      )}

      {plpInfo && (
        <PanelCard>
          <Typography variant="body1" sx={{ fontSize: '0.9rem', mb: 1, fontWeight: 500 }}>
            ATSC 3.0 PLP Information
          </Typography>
          <TableContainer component={Paper} sx={{ backgroundColor: 'transparent', boxShadow: 'none' }}>
            <Table size="small" sx={{ '& .MuiTableCell-root': { py: 0.5, fontSize: '0.8rem' } }}>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 600 }}>PLP</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Modulation</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Code Rate</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Layer</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Time Interleaving</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>LLS</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Lock</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {Object.entries(plpInfo).map(([plpId, info]) => (
                  <TableRow key={plpId}>
                    <TableCell>
                      <Chip
                        label={plpId}
                        size="small"
                        color="primary"
                        variant="outlined"
                        sx={{ height: 20, fontSize: '0.7rem' }}
                      />
                    </TableCell>
                    <TableCell>{info.modulation || 'N/A'}</TableCell>
                    <TableCell>{info.coderate || 'N/A'}</TableCell>
                    <TableCell>{info.layer || 'N/A'}</TableCell>
                    <TableCell>{info.timeInterleaving || 'N/A'}</TableCell>
                    <TableCell>
                      <Chip
                        label={info.lls ? 'Yes' : 'No'}
                        size="small"
                        color={info.lls ? 'success' : 'default'}
                        sx={{ height: 18, fontSize: '0.65rem' }}
                      />
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={info.lock ? 'Locked' : 'Unlocked'}
                        size="small"
                        color={info.lock ? 'success' : 'error'}
                        sx={{ height: 18, fontSize: '0.65rem' }}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </PanelCard>
      )}

      {l1Info && (
        <PanelCard>
          <Typography variant="body1" sx={{ fontSize: '0.9rem', mb: 1, fontWeight: 500 }}>
            ATSC 3.0 L1 Information
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 1 }}>
            {Object.entries(l1Info).map(([key, value]) => (
              <Box key={key} sx={{ display: 'flex', justifyContent: 'space-between', p: 0.5, backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 1 }}>
                <Typography variant="body2" sx={{ fontSize: '0.75rem', fontWeight: 500 }}>
                  {key.replace(/_/g, ' ').toUpperCase()}:
                </Typography>
                <Typography variant="body2" sx={{ fontSize: '0.75rem' }}>
                  {value}
                </Typography>
              </Box>
            ))}
          </Box>
        </PanelCard>
      )}
    </>
  );
}
