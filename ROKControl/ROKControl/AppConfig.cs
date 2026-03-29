using System;
using System.Xml;
using System.IO;

namespace ROKControl
{
    /// <summary>
    /// Persistent application configuration stored in \My Documents\ROKControl\config.xml
    /// </summary>
    public class AppConfig
    {
        // File location on device
        public static readonly string ConfigDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.Personal), "ROKControl");
        public static readonly string ConfigPath = Path.Combine(ConfigDir, "config.xml");

        // Server connectivity (HTTP)
        public string ServerUrl { get; set; }   // e.g. http://192.168.1.100:3000
        public string ApiToken  { get; set; }   // x-admin-token UUID

        // Event info
        public string EventName { get; set; }
        public string ControlPointName { get; set; }
        public int ControlPointNumber { get; set; }

        // Behaviour flags
        public bool AutoDriverChange { get; set; }
        public bool AutoNewForm { get; set; }
        public int ControlsPerForm { get; set; }
        public bool FiaDecoding { get; set; }

        // Scanner hardware (datalogic = 0, symbol = 1, psion = 2, manual = 3)
        public int ScannerType { get; set; }

        // RFID enabled flag
        public bool RfidEnabled { get; set; }

        // Selected event (picked at startup from server)
        public int    EventId   { get; set; }   // 0 = not selected

        public AppConfig()
        {
            // Defaults
            ServerUrl = "http://10.0.0.18:3000";
            ApiToken  = "0298423f-ab4b-4a48-abad-31a3e72dc463";
            EventName = "ROK Cup Event";
            ControlPointName = "Control 1";
            ControlPointNumber = 1;
            AutoDriverChange = true;
            AutoNewForm = false;
            ControlsPerForm = 11;
            FiaDecoding = false;
            ScannerType = 0;
            RfidEnabled = true;
            EventId     = 0;
        }

        public static AppConfig Load()
        {
            AppConfig cfg = new AppConfig();
            if (!File.Exists(ConfigPath))
                return cfg;

            try
            {
                XmlDocument doc = new XmlDocument();
                doc.Load(ConfigPath);
                XmlElement root = doc.DocumentElement;

                cfg.ServerUrl = GetStr(root, "ServerUrl", cfg.ServerUrl);
                cfg.ApiToken  = GetStr(root, "ApiToken",  cfg.ApiToken);
                // Always fall back to hardcoded defaults if blank
                if (string.IsNullOrEmpty(cfg.ServerUrl))
                    cfg.ServerUrl = "http://10.0.0.18:3000";
                if (string.IsNullOrEmpty(cfg.ApiToken))
                    cfg.ApiToken = "0298423f-ab4b-4a48-abad-31a3e72dc463";
                cfg.EventName = GetStr(root, "EventName", cfg.EventName);
                cfg.ControlPointName = GetStr(root, "ControlPointName", cfg.ControlPointName);
                cfg.ControlPointNumber = GetInt(root, "ControlPointNumber", cfg.ControlPointNumber);
                cfg.AutoDriverChange = GetBool(root, "AutoDriverChange", cfg.AutoDriverChange);
                cfg.AutoNewForm = GetBool(root, "AutoNewForm", cfg.AutoNewForm);
                cfg.ControlsPerForm = GetInt(root, "ControlsPerForm", cfg.ControlsPerForm);
                cfg.FiaDecoding = GetBool(root, "FiaDecoding", cfg.FiaDecoding);
                cfg.ScannerType = GetInt(root, "ScannerType", cfg.ScannerType);
                cfg.RfidEnabled = GetBool(root, "RfidEnabled", cfg.RfidEnabled);
                cfg.EventId     = GetInt(root,  "EventId",     cfg.EventId);
            }
            catch { /* return defaults on any parse error */ }

            return cfg;
        }

        public void Save()
        {
            if (!Directory.Exists(ConfigDir))
                Directory.CreateDirectory(ConfigDir);

            XmlDocument doc = new XmlDocument();
            XmlElement root = doc.CreateElement("ROKControlConfig");
            doc.AppendChild(root);

            SetStr(doc, root, "ServerUrl", ServerUrl);
            SetStr(doc, root, "ApiToken",  ApiToken);
            SetStr(doc, root, "EventName", EventName);
            SetStr(doc, root, "ControlPointName", ControlPointName);
            SetStr(doc, root, "ControlPointNumber", ControlPointNumber.ToString());
            SetStr(doc, root, "AutoDriverChange", AutoDriverChange ? "true" : "false");
            SetStr(doc, root, "AutoNewForm", AutoNewForm ? "true" : "false");
            SetStr(doc, root, "ControlsPerForm", ControlsPerForm.ToString());
            SetStr(doc, root, "FiaDecoding", FiaDecoding ? "true" : "false");
            SetStr(doc, root, "ScannerType", ScannerType.ToString());
            SetStr(doc, root, "RfidEnabled", RfidEnabled ? "true" : "false");
            SetStr(doc, root, "EventId",     EventId.ToString());

            doc.Save(ConfigPath);
        }

        // --- XML helpers ---
        private static string GetStr(XmlElement root, string name, string def)
        {
            XmlNode n = root.SelectSingleNode(name);
            return (n != null) ? n.InnerText : def;
        }
        private static int GetInt(XmlElement root, string name, int def)
        {
            XmlNode n = root.SelectSingleNode(name);
            if (n == null) return def;
            try { return int.Parse(n.InnerText); } catch { return def; }
        }
        private static bool GetBool(XmlElement root, string name, bool def)
        {
            XmlNode n = root.SelectSingleNode(name);
            if (n == null) return def;
            return n.InnerText.ToLower() == "true";
        }
        private static void SetStr(XmlDocument doc, XmlElement root, string name, string value)
        {
            XmlElement el = doc.CreateElement(name);
            el.InnerText = value ?? string.Empty;
            root.AppendChild(el);
        }
    }
}
