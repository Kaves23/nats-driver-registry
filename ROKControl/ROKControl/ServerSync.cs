using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace ROKControl
{
    /// <summary>
    /// Handles HTTP synchronisation with the race server.
    ///
    /// POST /api/rokcontrol/sync
    /// Headers: x-admin-token: {ApiToken}
    /// Body: JSON { records:[...], controlPoint:N, controlPointName:"...", eventName:"..." }
    /// </summary>
    public class ServerSync
    {
        private readonly AppConfig _cfg;
        public event EventHandler<SyncProgressEventArgs> Progress;

        public ServerSync(AppConfig cfg)
        {
            _cfg = cfg;
        }

        /// <summary>
        /// Send all locally stored control records to the server via HTTP POST.
        /// This is called from a worker thread; fires Progress events back to UI.
        /// </summary>
        public void SyncAllToServer()
        {
            List<string[]> rows = DataStore.ReadRawControls();
            if (rows.Count == 0)
            {
                RaiseProgress("No records to sync.", true, 0);
                return;
            }

            if (string.IsNullOrEmpty(_cfg.ServerUrl))
            {
                RaiseProgress("Server URL not configured.", true, 0);
                return;
            }

            string url = _cfg.ServerUrl.TrimEnd('/') + "/api/rokcontrol/sync";
            RaiseProgress("Connecting to server...", false, 0);

            try
            {
                string json = BuildBatchJson(rows);
                RaiseProgress(string.Format("Sending {0} records...", rows.Count), false, 10);
                string response = PostJson(url, json);
                DataStore.AppendSyncLog(string.Format("Synced {0} records: {1}", rows.Count, response));
                DataStore.ClearAllRecords();
                RaiseProgress(string.Format("Done. {0} records sent.", rows.Count), true, 100);
            }
            catch (Exception ex)
            {
                string msg;
                System.Net.WebException we = ex as System.Net.WebException;
                if (we != null)
                    msg = "WebException status=" + (int)we.Status + " url=" + url;
                else
                    msg = ex.GetType().Name + " url=" + url;
                DataStore.AppendSyncLog(msg);
                RaiseProgress("Sync failed: " + msg, true, 0);
            }
        }

        /// <summary>
        /// Send a single record immediately (live / fire-and-forget mode).
        /// </summary>
        public bool SendLive(ControlRecord rec)
        {
            if (string.IsNullOrEmpty(_cfg.ServerUrl))
                return false;

            string url = _cfg.ServerUrl.TrimEnd('/') + "/api/rokcontrol/sync";
            try
            {
                string json = BuildSingleJson(rec);
                PostJson(url, json);
                return true;
            }
            catch
            {
                return false;
            }
        }

        // ── HTTP helper ────────────────────────────────────────────────────────

        private string PostJson(string url, string json)
        {
            byte[] body = Encoding.UTF8.GetBytes(json);
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Method           = "POST";
            req.ContentType      = "application/json; charset=utf-8";
            req.ContentLength    = body.Length;
            req.Timeout          = 15000;
            req.ProtocolVersion  = HttpVersion.Version10;  // CF: avoids chunked transfer encoding (ReceiveFailure status=3)
            req.KeepAlive        = false;

            if (!string.IsNullOrEmpty(_cfg.ApiToken))
                req.Headers.Add("x-admin-token", _cfg.ApiToken);
            req.Headers.Add("Accept-Encoding", "identity");  // CF: disable gzip, plain text response only

            using (Stream s = req.GetRequestStream())
                s.Write(body, 0, body.Length);

            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
            using (StreamReader sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                return sr.ReadToEnd();
        }

        // ── JSON builders ──────────────────────────────────────────────────────

        private string BuildBatchJson(List<string[]> rows)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"records\":[");
            for (int i = 0; i < rows.Count; i++)
            {
                if (i > 0) sb.Append(',');
                AppendRowJson(sb, rows[i]);
            }
            sb.Append("],");
            sb.Append("\"controlPoint\":");
            sb.Append(_cfg.ControlPointNumber);
            sb.Append(",\"controlPointName\":\"");
            sb.Append(J(_cfg.ControlPointName));
            sb.Append("\",\"eventName\":\"");
            sb.Append(J(_cfg.EventName));
            sb.Append("\"}");
            return sb.ToString();
        }

        private string BuildSingleJson(ControlRecord rec)
        {
            // Convert ControlRecord to the same tab-delimited row format used by DataStore
            // Format: ts, vehicle, driver, class, control, heat, item1..11, tyreFL, FR, RL, RR
            string[] row = new string[21];
            row[0] = rec.Timestamp.ToString(DataStore.TimestampFormat);
            row[1] = rec.VehicleNumber  ?? string.Empty;
            row[2] = rec.DriverName     ?? string.Empty;
            row[3] = rec.ClassName      ?? string.Empty;
            row[4] = rec.ControlCode    ?? string.Empty;
            row[5] = rec.HeatName       ?? string.Empty;
            for (int i = 0; i < 11; i++)
                row[6 + i] = (i < rec.Items.Count) ? (rec.Items[i].Code ?? string.Empty) : string.Empty;
            row[17] = rec.TyreFrontLeft  ?? string.Empty;
            row[18] = rec.TyreFrontRight ?? string.Empty;
            row[19] = rec.TyreRearLeft   ?? string.Empty;
            row[20] = rec.TyreRearRight  ?? string.Empty;

            List<string[]> rows = new List<string[]>();
            rows.Add(row);
            return BuildBatchJson(rows);
        }

        private void AppendRowJson(StringBuilder sb, string[] r)
        {
            // Row indices: 0=ts, 1=vehicle, 2=driver, 3=class, 4=control,
            //              5=heat, 6-16=items[0-10], 17=tyreFL, 18=tyreFR, 19=tyreRL, 20=tyreRR
            string ts      = r.Length > 0  ? r[0]  : string.Empty;
            string vehicle = r.Length > 1  ? r[1]  : string.Empty;
            string driver  = r.Length > 2  ? r[2]  : string.Empty;
            string cls     = r.Length > 3  ? r[3]  : string.Empty;
            string control = r.Length > 4  ? r[4]  : string.Empty;
            string heat    = r.Length > 5  ? r[5]  : string.Empty;
            string tyreFL  = r.Length > 17 ? r[17] : string.Empty;
            string tyreFR  = r.Length > 18 ? r[18] : string.Empty;
            string tyreRL  = r.Length > 19 ? r[19] : string.Empty;
            string tyreRR  = r.Length > 20 ? r[20] : string.Empty;

            sb.Append("{\"ts\":\"");       sb.Append(J(ts));      sb.Append("\",");
            sb.Append("\"vehicle\":\"");   sb.Append(J(vehicle)); sb.Append("\",");
            sb.Append("\"driver\":\"");    sb.Append(J(driver));  sb.Append("\",");
            sb.Append("\"class\":\"");     sb.Append(J(cls));     sb.Append("\",");
            sb.Append("\"control\":\"");   sb.Append(J(control)); sb.Append("\",");
            sb.Append("\"heat\":\"");      sb.Append(J(heat));    sb.Append("\",");
            sb.Append("\"items\":[");
            for (int i = 0; i < 11; i++)
            {
                if (i > 0) sb.Append(',');
                string item = (r.Length > 6 + i) ? r[6 + i] : string.Empty;
                sb.Append('"'); sb.Append(J(item)); sb.Append('"');
            }
            sb.Append("],");
            sb.Append("\"tyreFL\":\""); sb.Append(J(tyreFL)); sb.Append("\",");
            sb.Append("\"tyreFR\":\""); sb.Append(J(tyreFR)); sb.Append("\",");
            sb.Append("\"tyreRL\":\""); sb.Append(J(tyreRL)); sb.Append("\",");
            sb.Append("\"tyreRR\":\""); sb.Append(J(tyreRR)); sb.Append("\"}");
        }

        /// <summary>Escape a string value for embedding inside a JSON string literal.</summary>
        private static string J(string s)
        {
            if (s == null) return string.Empty;
            s = s.Replace("\\", "\\\\");
            s = s.Replace("\"", "\\\"");
            s = s.Replace("\r", "\\r");
            s = s.Replace("\n", "\\n");
            s = s.Replace("\t", "\\t");
            return s;
        }

        // ── Registration (live, single scan) ──────────────────────────────────

        /// <summary>
        /// Send engine assignment via raw TCP socket — completely bypasses
        /// CF's broken HttpWebRequest which fails with ReceiveFailure (status=3)
        /// on any modern HTTP server response.
        /// </summary>
        public RegistrationResult SendRegistration(string vehicleNumber, string engineSerial)
        {
            if (string.IsNullOrEmpty(_cfg.ServerUrl))
                return new RegistrationResult { Success = false, Message = "Server URL not configured." };

            try
            {
                Uri    uri  = new Uri(_cfg.ServerUrl.TrimEnd('/') + "/api/rokcontrol/register");
                string host = uri.Host;
                int    port = uri.Port > 0 ? uri.Port : 80;
                string path = uri.PathAndQuery;

                string jsonBody = "{\"race_number\":\"" + J(vehicleNumber) +
                                  "\",\"engine_serial\":\"" + J(engineSerial) +
                                  "\",\"scanned_by\":\"ROKControl\"}";
                byte[] bodyBytes = Encoding.UTF8.GetBytes(jsonBody);

                // Build a minimal HTTP/1.0 POST request — no chunking, no keep-alive
                string headers =
                    "POST " + path + " HTTP/1.0\r\n" +
                    "Host: " + host + ":" + port + "\r\n" +
                    "Content-Type: application/json; charset=utf-8\r\n" +
                    "Content-Length: " + bodyBytes.Length + "\r\n" +
                    "x-admin-token: " + (_cfg.ApiToken ?? "") + "\r\n" +
                    "Connection: close\r\n" +
                    "\r\n";
                byte[] headerBytes = Encoding.UTF8.GetBytes(headers);

                System.Net.Sockets.TcpClient tcp = new System.Net.Sockets.TcpClient();
                tcp.Connect(host, port);

                System.Net.Sockets.NetworkStream ns = tcp.GetStream();
                ns.Write(headerBytes, 0, headerBytes.Length);
                ns.Write(bodyBytes,   0, bodyBytes.Length);
                ns.Flush();

                // Read just the first 128 bytes — enough to get "HTTP/1.x NNN"
                byte[] buf   = new byte[128];
                int    read  = ns.Read(buf, 0, buf.Length);
                string resp  = Encoding.UTF8.GetString(buf, 0, read);
                tcp.Close();

                // Parse status code from "HTTP/1.x 200 OK..."
                int spaceIdx = resp.IndexOf(' ');
                if (spaceIdx >= 0 && resp.Length >= spaceIdx + 4)
                {
                    string codeStr = resp.Substring(spaceIdx + 1, 3);
                    try
                    {
                        int code = int.Parse(codeStr);
                        if (code >= 200 && code < 300)
                            return new RegistrationResult { Success = true, Message = "Sent OK (" + vehicleNumber + ")" };
                        else
                            return new RegistrationResult { Success = false, Message = "HTTP " + code };
                    }
                    catch { }
                }
                return new RegistrationResult { Success = false, Message = "Bad resp: " + resp };
            }
            catch (System.Net.Sockets.SocketException se)
            {
                // ErrorCode numbers: 10061=connection refused, 10060=timeout, 10051=network unreachable
                return new RegistrationResult { Success = false, Message = "Socket " + se.ErrorCode + " -> " + _cfg.ServerUrl };
            }
            catch (Exception ex)
            {
                return new RegistrationResult { Success = false, Message = ex.GetType().Name + " -> " + _cfg.ServerUrl };
            }
        }

        private RegistrationResult ParseRegistrationResponse(string json, string url)
        {
            bool   success    = json.Contains("\"success\":true");
            string driverName = ExtractJsonString(json, "driver_name") ?? string.Empty;
            string raceClass  = ExtractJsonString(json, "race_class")  ?? string.Empty;
            string error      = ExtractJsonString(json, "error")       ?? string.Empty;
            return new RegistrationResult
            {
                Success    = success,
                DriverName = driverName,
                RaceClass  = raceClass,
                Message    = success
                    ? string.Format("{0}  [{1}]", driverName, raceClass)
                    : (error.Length > 0 ? error : "Server error")
            };
        }

        private static string ExtractJsonString(string json, string key)
        {
            string search = "\"" + key + "\":\"";
            int start = json.IndexOf(search);
            if (start < 0) return null;
            start += search.Length;
            int end = json.IndexOf("\"", start);
            if (end < 0) return null;
            return json.Substring(start, end - start);
        }

        // ── Event list fetch ──────────────────────────────────────────────────

        /// <summary>
        /// Fetch the list of events from GET /api/public/events (no auth required).
        /// Returns null on failure; caller should handle gracefully.
        /// Uses raw TCP — same pattern as SendRegistration.
        /// </summary>
        public List<EventRecord> FetchEvents()
        {
            if (string.IsNullOrEmpty(_cfg.ServerUrl))
                return null;
            try
            {
                Uri    uri  = new Uri(_cfg.ServerUrl.TrimEnd('/') + "/api/public/events");
                string host = uri.Host;
                int    port = uri.Port > 0 ? uri.Port : 80;
                string path = uri.PathAndQuery;

                string req =
                    "GET " + path + " HTTP/1.0\r\n" +
                    "Host: " + host + ":" + port + "\r\n" +
                    "Connection: close\r\n" +
                    "\r\n";
                byte[] reqBytes = Encoding.UTF8.GetBytes(req);

                TcpClient tcp = new TcpClient();
                tcp.Connect(host, port);
                NetworkStream ns = tcp.GetStream();
                ns.Write(reqBytes, 0, reqBytes.Length);
                ns.Flush();

                // Read full response (events list is small — < 8KB)
                System.IO.MemoryStream ms = new System.IO.MemoryStream();
                byte[] buf = new byte[1024];
                int read;
                while ((read = ns.Read(buf, 0, buf.Length)) > 0)
                    ms.Write(buf, 0, read);
                tcp.Close();

                string body = Encoding.UTF8.GetString(ms.ToArray());

                // Strip HTTP headers — body starts after \r\n\r\n
                int bodyStart = body.IndexOf("\r\n\r\n");
                if (bodyStart >= 0) body = body.Substring(bodyStart + 4);

                return ParseEventList(body);
            }
            catch
            {
                return null;
            }
        }

        private List<EventRecord> ParseEventList(string json)
        {
            List<EventRecord> results = new List<EventRecord>();
            // Find the events array: "events":[{...},{...}]
            int arrStart = json.IndexOf("\"events\":[");
            if (arrStart < 0) return results;
            arrStart = json.IndexOf('[', arrStart);
            if (arrStart < 0) return results;
            int arrEnd = json.IndexOf(']', arrStart);
            if (arrEnd < 0) return results;
            string arr = json.Substring(arrStart + 1, arrEnd - arrStart - 1);

            // Split into individual objects by "},{"
            int pos = 0;
            while (pos < arr.Length)
            {
                int objStart = arr.IndexOf('{', pos);
                if (objStart < 0) break;
                int objEnd = arr.IndexOf('}', objStart);
                if (objEnd < 0) break;
                string obj = arr.Substring(objStart, objEnd - objStart + 1);

                EventRecord ev = new EventRecord();
                ev.EventId   = ExtractJsonInt(obj, "event_id");
                ev.EventName = ExtractJsonString(obj, "event_name") ?? "(unnamed)";
                ev.EventDate = ExtractJsonString(obj, "event_date") ?? string.Empty;
                // Trim date to just yyyy-MM-dd
                if (ev.EventDate.Length > 10) ev.EventDate = ev.EventDate.Substring(0, 10);
                if (ev.EventId > 0)
                    results.Add(ev);

                pos = objEnd + 1;
            }
            return results;
        }

        private static int ExtractJsonInt(string json, string key)
        {
            string search = "\"" + key + "\":";
            int start = json.IndexOf(search);
            if (start < 0) return 0;
            start += search.Length;
            // Skip whitespace
            while (start < json.Length && json[start] == ' ') start++;
            int end = start;
            while (end < json.Length && (char.IsDigit(json[end]) || json[end] == '-')) end++;
            if (end == start) return 0;
            try { return int.Parse(json.Substring(start, end - start)); } catch { return 0; }
        }

        private void RaiseProgress(string message, bool done, int percent)
        {
            if (Progress != null)
                Progress(this, new SyncProgressEventArgs(message, done, percent));
        }
    }

    public class RegistrationResult
    {
        public bool   Success    { get; set; }
        public string DriverName { get; set; }
        public string RaceClass  { get; set; }
        public string Message    { get; set; }
    }

    public class EventRecord
    {
        public int    EventId   { get; set; }
        public string EventName { get; set; }
        public string EventDate { get; set; }

        public override string ToString()
        {
            if (!string.IsNullOrEmpty(EventDate))
                return EventDate + "  " + EventName;
            return EventName;
        }
    }

    public class SyncProgressEventArgs : EventArgs
    {
        public string Message { get; private set; }
        public bool IsDone    { get; private set; }
        public int Percent    { get; private set; }

        public SyncProgressEventArgs(string message, bool done, int pct)
        {
            Message = message;
            IsDone  = done;
            Percent = pct;
        }
    }
}
