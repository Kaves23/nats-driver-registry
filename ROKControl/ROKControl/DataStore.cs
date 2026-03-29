using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace ROKControl
{
    /// <summary>
    /// Represents a single scanned control record for one driver pass-through.
    /// </summary>
    public class ControlRecord
    {
        public DateTime Timestamp { get; set; }
        public string VehicleNumber { get; set; }
        public string DriverName { get; set; }
        public string ClassName { get; set; }
        public string ControlCode { get; set; }
        public int ControlPointNumber { get; set; }
        public string HeatName { get; set; }

        // Up to 11 scanned items per pass-through
        public List<ScanItem> Items { get; private set; }

        // Tyre RFID tags (4 positions)
        public string TyreFrontLeft { get; set; }
        public string TyreFrontRight { get; set; }
        public string TyreRearLeft { get; set; }
        public string TyreRearRight { get; set; }

        public ControlRecord()
        {
            Timestamp = DateTime.Now;
            Items = new List<ScanItem>();
        }
    }

    /// <summary>
    /// A single scanned item within a control pass-through (e.g. engine serial, tyre barcode).
    /// </summary>
    public class ScanItem
    {
        public int SlotIndex { get; set; }      // 1-11
        public string Title { get; set; }       // Label shown on screen (e.g. "Engine", "Tyre FL")
        public string Code { get; set; }        // Scanned barcode / RFID value
        public bool IsRfid { get; set; }
        public DateTime ScannedAt { get; set; }

        public ScanItem()
        {
            ScannedAt = DateTime.Now;
        }
    }

    /// <summary>
    /// Simple driver record fetched from the server driver list.
    /// </summary>
    public class DriverEntry
    {
        public string VehicleNumber { get; set; }
        public string DriverName    { get; set; }
        public string ClassName     { get; set; }
    }

    /// <summary>
    /// Handles all local file I/O: writing export files and reading them back.
    /// </summary>
    public static class DataStore
    {
        // Timestamp format matching GoControl protocol
        public const string TimestampFormat = "yyyyMMddHHmmss";
        public const string DisplayDateFormat = "dd/MM/yyyy HH:mm:ss";

        private static string ExportDir
        {
            get
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.Personal),
                    "ROKControl");
            }
        }

        private static string ControlsFile { get { return Path.Combine(ExportDir, "export_controls.txt"); } }
        private static string RecordsFile  { get { return Path.Combine(ExportDir, "export_records.txt"); } }
        private static string SynchroFile  { get { return Path.Combine(ExportDir, "synchro.txt"); } }

        private static void EnsureDir()
        {
            if (!Directory.Exists(ExportDir))
                Directory.CreateDirectory(ExportDir);
        }

        /// <summary>
        /// Append a completed control record to export_controls.txt
        /// Format: Timestamp\tVehicle\tDriver\tClass\tControl\tHeat\tItem1\tItem2...\tTyre_FL\tTyre_FR\tTyre_RL\tTyre_RR
        /// </summary>
        public static void AppendControl(ControlRecord rec)
        {
            EnsureDir();
            StringBuilder sb = new StringBuilder();
            sb.Append(rec.Timestamp.ToString(TimestampFormat));
            sb.Append('\t');
            sb.Append(rec.VehicleNumber ?? string.Empty);
            sb.Append('\t');
            sb.Append(rec.DriverName ?? string.Empty);
            sb.Append('\t');
            sb.Append(rec.ClassName ?? string.Empty);
            sb.Append('\t');
            sb.Append(rec.ControlCode ?? string.Empty);
            sb.Append('\t');
            sb.Append(rec.HeatName ?? string.Empty);

            for (int i = 0; i < 11; i++)
            {
                sb.Append('\t');
                if (i < rec.Items.Count)
                    sb.Append(rec.Items[i].Code ?? string.Empty);
            }

            sb.Append('\t'); sb.Append(rec.TyreFrontLeft ?? string.Empty);
            sb.Append('\t'); sb.Append(rec.TyreFrontRight ?? string.Empty);
            sb.Append('\t'); sb.Append(rec.TyreRearLeft ?? string.Empty);
            sb.Append('\t'); sb.Append(rec.TyreRearRight ?? string.Empty);

            using (StreamWriter sw = new StreamWriter(ControlsFile, true, Encoding.UTF8))
                sw.Write(sb.ToString() + "\r\n");
        }

        /// <summary>
        /// Append a sync log entry to synchro.txt
        /// </summary>
        public static void AppendSyncLog(string message)
        {
            EnsureDir();
            string line = DateTime.Now.ToString(TimestampFormat) + "\t" + message + "\r\n";
            using (StreamWriter sw = new StreamWriter(SynchroFile, true, Encoding.UTF8))
                sw.Write(line);
        }

        /// <summary>
        /// Read all control records back from export_controls.txt (for display or re-send).
        /// </summary>
        public static List<string[]> ReadRawControls()
        {
            List<string[]> rows = new List<string[]>();
            if (!File.Exists(ControlsFile)) return rows;

            try
            {
                using (StreamReader sr = new StreamReader(ControlsFile, Encoding.UTF8))
                {
                    string line;
                    while ((line = sr.ReadLine()) != null)
                        if (!string.IsNullOrEmpty(line))
                            rows.Add(line.Split('\t'));
                }
            }
            catch { }
            return rows;
        }

        /// <summary>
        /// Delete all local export files (after confirmed sync or at event reset).
        /// </summary>
        public static void ClearAllRecords()
        {
            try { if (File.Exists(ControlsFile)) File.Delete(ControlsFile); } catch { }
            try { if (File.Exists(RecordsFile))  File.Delete(RecordsFile); } catch { }
        }

        /// <summary>
        /// Count how many records are stored locally.
        /// </summary>
        public static int CountRecords()
        {
            if (!File.Exists(ControlsFile)) return 0;
            try
            {
                int count = 0;
                using (StreamReader sr = new StreamReader(ControlsFile, Encoding.UTF8))
                {
                    string line;
                    while ((line = sr.ReadLine()) != null)
                        if (!string.IsNullOrEmpty(line)) count++;
                }
                return count;
            }
            catch { return 0; }
        }
    }
}
