using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace DownloadPathRouter
{
    internal static class Host
    {
        private const int MaximumMessageBytes = 1024 * 1024;
        private const string Version = "0.2.0";
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
        private static readonly Regex OriginPattern = new Regex(@"^chrome-extension://[a-p]{32}/$", RegexOptions.CultureInvariant);
        private static readonly Regex DeviceName = new Regex(@"^(CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3]) *(\.|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaximumMessageBytes, RecursionLimit = 32 };

        public static int Main(string[] args)
        {
            bool authorizedOrigin = args.Length > 0 && OriginPattern.IsMatch(args[0]);
            Stream input = Console.OpenStandardInput();
            Stream output = Console.OpenStandardOutput();
            while (true)
            {
                try
                {
                    byte[] header = new byte[4];
                    if (!ReadExactly(input, header, true)) return 0;
                    uint length = (uint)(header[0] | header[1] << 8 | header[2] << 16 | header[3] << 24);
                    if (length == 0 || length > MaximumMessageBytes)
                    {
                        WriteResponse(output, Failure("消息长度必须介于 1 字节与 1 MB 之间。"));
                        return 1;
                    }
                    byte[] payload = new byte[(int)length];
                    ReadExactly(input, payload, false);
                    Dictionary<string, object> response;
                    try
                    {
                        if (!authorizedOrigin) throw new InvalidOperationException("不受支持的扩展来源。请通过已安装的 Chrome 扩展使用本程序。");
                        object parsed = Json.DeserializeObject(Utf8.GetString(payload));
                        Dictionary<string, object> request = parsed as Dictionary<string, object>;
                        if (request == null) throw new InvalidOperationException("请求必须是 JSON 对象。");
                        response = Handle(request);
                    }
                    catch (Exception error)
                    {
                        response = Failure(error.Message);
                    }
                    WriteResponse(output, response);
                }
                catch (EndOfStreamException)
                {
                    try { WriteResponse(output, Failure("消息帧不完整。")); } catch { }
                    return 1;
                }
                catch (Exception)
                {
                    // Native Messaging reserves stdout exclusively for framed JSON.
                    return 1;
                }
            }
        }

        private static bool ReadExactly(Stream input, byte[] buffer, bool allowCleanEnd)
        {
            int offset = 0;
            while (offset < buffer.Length)
            {
                int count = input.Read(buffer, offset, buffer.Length - offset);
                if (count == 0)
                {
                    if (offset == 0 && allowCleanEnd) return false;
                    throw new EndOfStreamException();
                }
                offset += count;
            }
            return true;
        }

        private static void WriteResponse(Stream output, Dictionary<string, object> response)
        {
            byte[] bytes = Utf8.GetBytes(Json.Serialize(response));
            int length = bytes.Length;
            byte[] header = new byte[] { (byte)length, (byte)(length >> 8), (byte)(length >> 16), (byte)(length >> 24) };
            output.Write(header, 0, header.Length);
            output.Write(bytes, 0, bytes.Length);
            output.Flush();
        }

        private static Dictionary<string, object> Failure(string message)
        {
            return new Dictionary<string, object> { { "ok", false }, { "error", String.IsNullOrEmpty(message) ? "本机文件操作失败。" : message } };
        }

        private static string RequiredString(Dictionary<string, object> input, string key)
        {
            object value;
            if (!input.TryGetValue(key, out value) || !(value is string) || String.IsNullOrEmpty((string)value))
                throw new InvalidOperationException("缺少有效字段：" + key);
            return (string)value;
        }

        private static Dictionary<string, object> Handle(Dictionary<string, object> request)
        {
            string operation = RequiredString(request, "operation");
            if (operation == "ping") return new Dictionary<string, object> { { "ok", true }, { "version", Version } };
            if (operation == "move") return Move(request);
            if (operation == "reveal") return Reveal(request);
            throw new InvalidOperationException("不支持的操作。");
        }

        private static string LocalPath(string value)
        {
            if (value == null || value.Length < 3 || value.Length > 32700 || !Regex.IsMatch(value, @"^[a-zA-Z]:[\\/]"))
                throw new InvalidOperationException("仅支持本机盘符开头的完整 Windows 路径。");
            string normalized = value.Replace('/', '\\');
            string rest = normalized.Substring(3);
            if (rest.EndsWith("\\", StringComparison.Ordinal)) rest = rest.Substring(0, rest.Length - 1);
            string[] components = rest.Length == 0 ? new string[0] : rest.Split('\\');
            foreach (string component in components)
            {
                if (component.Length == 0 || component == "." || component == ".." || component.EndsWith(" ", StringComparison.Ordinal) || component.EndsWith(".", StringComparison.Ordinal))
                    throw new InvalidOperationException("路径不能包含空片段、.、..、末尾空格或句点。");
                if (component.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || component.IndexOf(':') >= 0 || DeviceName.IsMatch(component))
                    throw new InvalidOperationException("路径包含非法字符、设备名或备用数据流。");
            }
            string full = Path.GetFullPath(normalized);
            string root = Path.GetPathRoot(full);
            DriveInfo drive = new DriveInfo(root);
            if (drive.DriveType == DriveType.Network || drive.DriveType == DriveType.NoRootDirectory || drive.DriveType == DriveType.Unknown)
                throw new InvalidOperationException("不能使用网络盘或不存在的本机盘符。");
            return full.Length > 3 ? full.TrimEnd('\\') : full;
        }

        private static void CheckAncestors(string path, bool leafMayBeFile)
        {
            string root = Path.GetPathRoot(path);
            string current = root;
            CheckExistingPart(current, false);
            string[] parts = path.Substring(root.Length).Split(new char[] { '\\' }, StringSplitOptions.RemoveEmptyEntries);
            for (int i = 0; i < parts.Length; i++)
            {
                current = Path.Combine(current, parts[i]);
                CheckExistingPart(current, leafMayBeFile && i == parts.Length - 1);
            }
        }

        private static void CheckExistingPart(string path, bool mayBeFile)
        {
            FileAttributes attributes;
            try { attributes = File.GetAttributes(path); }
            catch (FileNotFoundException) { return; }
            catch (DirectoryNotFoundException) { return; }
            if ((attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("路径不能经过符号链接、junction 或其他重解析点。");
            if (!mayBeFile && (attributes & FileAttributes.Directory) == 0)
                throw new InvalidOperationException("目标目录或其父路径已被文件占用。");
        }

        private static string JobsDirectory()
        {
            string applicationData = Environment.GetEnvironmentVariable("LOCALAPPDATA");
            if (String.IsNullOrEmpty(applicationData)) applicationData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string directory = LocalPath(Path.Combine(applicationData, "DownloadPathRouter", "jobs"));
            CheckAncestors(directory, false);
            Directory.CreateDirectory(directory);
            CheckAncestors(directory, false);
            return directory;
        }

        private static Dictionary<string, object> Move(Dictionary<string, object> request)
        {
            string suppliedId = RequiredString(request, "jobId");
            Guid parsedId;
            if (!Guid.TryParseExact(suppliedId, "D", out parsedId) || suppliedId.Length != 36) throw new InvalidOperationException("jobId 必须是标准 UUID。");
            string jobId = parsedId.ToString("D");
            string source = LocalPath(RequiredString(request, "sourcePath"));
            string destination = LocalPath(RequiredString(request, "destinationDirectory"));
            DirectoryInfo sourceParent = Directory.GetParent(source);
            if (sourceParent == null || !String.Equals(sourceParent.Name, jobId, StringComparison.OrdinalIgnoreCase) || sourceParent.Parent == null || !String.Equals(sourceParent.Parent.Name, "_DownloadPathRouter", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("仅能移动 _DownloadPathRouter\\<jobId>\\ 文件暂存区中的任务文件。");
            if (String.Equals(Path.GetExtension(source), ".crdownload", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("不能移动尚未完成的 .crdownload 文件。");
            CheckAncestors(source, true);
            CheckAncestors(destination, false);
            string user = WindowsIdentity.GetCurrent().User.Value;
            using (Mutex mutex = new Mutex(false, @"Local\DownloadPathRouter_" + user + "_" + jobId))
            {
                bool acquired = false;
                try
                {
                    try { acquired = mutex.WaitOne(30000); } catch (AbandonedMutexException) { acquired = true; }
                    if (!acquired) throw new InvalidOperationException("同一下载任务仍在处理中，请稍后重试。");
                    return MoveLocked(jobId, source, destination, sourceParent.FullName);
                }
                finally { if (acquired) mutex.ReleaseMutex(); }
            }
        }

        private static Dictionary<string, object> MoveLocked(string jobId, string source, string destination, string stageDirectory)
        {
            string recordPath = Path.Combine(JobsDirectory(), jobId + ".json");
            JobRecord record = ReadRecord(recordPath);
            if (record != null)
            {
                ValidateRecord(record, jobId, source, destination);
                if (record.State == "completed") return MoveSuccess(record.FinalPath);
                Dictionary<string, object> recovered = Recover(record, recordPath, stageDirectory);
                if (recovered != null) return recovered;
            }
            else
            {
                RequireSource(source);
                Fingerprint fingerprint = Inspect(source);
                Directory.CreateDirectory(destination);
                CheckAncestors(destination, false);
                record = new JobRecord {
                    Version = 1, JobId = jobId, SourcePath = source, DestinationDirectory = destination,
                    SourceLength = fingerprint.Length, SourceHash = fingerprint.Hash,
                    State = "planned", Mode = String.Equals(Path.GetPathRoot(source), Path.GetPathRoot(destination), StringComparison.OrdinalIgnoreCase) ? "rename" : "copy",
                    FinalPath = FindCandidate(destination, Path.GetFileName(source)),
                    TemporaryPath = Path.Combine(destination, ".download-path-router-" + jobId + "-" + Guid.NewGuid().ToString("N") + ".partial")
                };
                SaveRecord(recordPath, record);
            }

            RequireSource(source);
            CheckAncestors(destination, false);
            Directory.CreateDirectory(destination);
            CheckAncestors(destination, false);
            if (!Matches(source, record)) throw new InvalidOperationException("暂存文件已变化，已保留原文件；请重新创建下载任务。");
            if (record.Mode == "rename")
            {
                while (true)
                {
                    record.FinalPath = FindCandidate(destination, Path.GetFileName(source));
                    SaveRecord(recordPath, record);
                    CheckAncestors(source, true);
                    CheckAncestors(record.FinalPath, true);
                    try { File.Move(source, record.FinalPath); break; }
                    catch (IOException) { if (File.Exists(record.FinalPath) || Directory.Exists(record.FinalPath)) continue; throw; }
                }
                Complete(record, recordPath, stageDirectory);
                return MoveSuccess(record.FinalPath);
            }

            if (record.State != "copied")
            {
                // A fresh random temporary name avoids touching any pre-existing file.
                record.TemporaryPath = Path.Combine(destination, ".download-path-router-" + jobId + "-" + Guid.NewGuid().ToString("N") + ".partial");
                record.State = "planned";
                SaveRecord(recordPath, record);
                bool ownsTemporary = false;
                try
                {
                    CheckAncestors(source, true);
                    CheckAncestors(record.TemporaryPath, true);
                    using (FileStream input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read))
                    using (FileStream output = new FileStream(record.TemporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    {
                        ownsTemporary = true;
                        input.CopyTo(output, 1024 * 1024);
                        output.Flush(true);
                    }
                    if (!Matches(record.TemporaryPath, record)) throw new IOException("目标副本校验失败，已保留暂存文件。");
                    record.State = "copied";
                    SaveRecord(recordPath, record);
                }
                catch
                {
                    if (ownsTemporary) TryDeleteTemporary(record.TemporaryPath);
                    throw;
                }
            }
            while (true)
            {
                record.FinalPath = FindCandidate(destination, Path.GetFileName(source));
                SaveRecord(recordPath, record);
                CheckAncestors(record.TemporaryPath, true);
                CheckAncestors(record.FinalPath, true);
                try { File.Move(record.TemporaryPath, record.FinalPath); break; }
                catch (IOException) { if (File.Exists(record.FinalPath) || Directory.Exists(record.FinalPath)) continue; throw; }
            }
            record.State = "committed";
            SaveRecord(recordPath, record);
            DeleteVerifiedSource(record);
            Complete(record, recordPath, stageDirectory);
            return MoveSuccess(record.FinalPath);
        }

        private static Dictionary<string, object> Recover(JobRecord record, string recordPath, string stageDirectory)
        {
            bool sourceExists = File.Exists(record.SourcePath);
            if (record.Mode == "rename")
            {
                if (sourceExists) return null;
                if (!Matches(record.FinalPath, record)) throw new IOException("任务暂存文件不存在，且无法验证先前的目标文件。请检查目标目录。");
                Complete(record, recordPath, stageDirectory);
                return MoveSuccess(record.FinalPath);
            }
            if (record.State == "committed" || (record.State == "copied" && !File.Exists(record.TemporaryPath)))
            {
                if (!Matches(record.FinalPath, record)) throw new IOException("无法验证先前的目标副本，已保留暂存文件。");
                DeleteVerifiedSource(record);
                Complete(record, recordPath, stageDirectory);
                return MoveSuccess(record.FinalPath);
            }
            if (!sourceExists) throw new IOException("任务暂存文件不存在，已停止处理。");
            if (record.State == "copied" && !Matches(record.TemporaryPath, record))
                throw new IOException("先前的临时副本校验失败，已保留暂存文件。");
            // A planned marker precedes CreateNew. Do not delete a file that may
            // have appeared independently before this process created its copy.
            return null;
        }

        private static void DeleteVerifiedSource(JobRecord record)
        {
            if (!File.Exists(record.SourcePath)) return;
            CheckAncestors(record.SourcePath, true);
            if (!Matches(record.SourcePath, record)) throw new IOException("目标副本已保存，但暂存文件发生变化，因此保留了暂存文件。");
            File.Delete(record.SourcePath);
        }

        private static void Complete(JobRecord record, string recordPath, string stageDirectory)
        {
            record.State = "completed";
            try { SaveRecord(recordPath, record); }
            catch { /* The durable planned/copied/committed marker can recover this successful move. */ }
            try { CheckAncestors(stageDirectory, false); Directory.Delete(stageDirectory, false); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            catch (InvalidOperationException) { }
        }

        private static void RequireSource(string source)
        {
            CheckAncestors(source, true);
            if (!File.Exists(source) || (File.GetAttributes(source) & FileAttributes.Directory) != 0)
                throw new FileNotFoundException("任务暂存文件不存在，或不是普通文件。");
        }

        private static string FindCandidate(string directory, string basename)
        {
            string stem = Path.GetFileNameWithoutExtension(basename);
            string extension = Path.GetExtension(basename);
            for (int number = 0; number < 100000; number++)
            {
                string name = number == 0 ? basename : stem + " (" + number.ToString(CultureInfo.InvariantCulture) + ")" + extension;
                string candidate = LocalPath(Path.Combine(directory, name));
                CheckAncestors(candidate, true);
                if (!File.Exists(candidate) && !Directory.Exists(candidate)) return candidate;
            }
            throw new IOException("目标目录中同名文件过多，无法分配新文件名。");
        }

        private sealed class Fingerprint
        {
            public long Length;
            public string Hash;
        }

        private static Fingerprint Inspect(string path)
        {
            CheckAncestors(path, true);
            using (FileStream input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (SHA256 sha = SHA256.Create())
                return new Fingerprint { Length = input.Length, Hash = BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "").ToLowerInvariant() };
        }

        private static bool Matches(string path, JobRecord record)
        {
            if (!File.Exists(path)) return false;
            Fingerprint fingerprint = Inspect(path);
            return fingerprint.Length == record.SourceLength && String.Equals(fingerprint.Hash, record.SourceHash, StringComparison.Ordinal);
        }

        private static void TryDeleteTemporary(string path)
        {
            try { CheckAncestors(path, true); if (File.Exists(path)) File.Delete(path); }
            catch { }
        }

        public sealed class JobRecord
        {
            public int Version { get; set; }
            public string JobId { get; set; }
            public string SourcePath { get; set; }
            public string DestinationDirectory { get; set; }
            public long SourceLength { get; set; }
            public string SourceHash { get; set; }
            public string FinalPath { get; set; }
            public string TemporaryPath { get; set; }
            public string Mode { get; set; }
            public string State { get; set; }
        }

        private static JobRecord ReadRecord(string path)
        {
            CheckAncestors(path, true);
            if (!File.Exists(path)) return null;
            FileInfo file = new FileInfo(path);
            if (file.Length > MaximumMessageBytes) throw new InvalidOperationException("任务记录过大，请检查本机任务记录。");
            JobRecord record = Json.Deserialize<JobRecord>(File.ReadAllText(path, Utf8));
            if (record == null) throw new InvalidOperationException("本机任务记录无效。");
            return record;
        }

        private static void ValidateRecord(JobRecord record, string jobId, string source, string destination)
        {
            if (record.Version != 1 || record.JobId != jobId || !String.Equals(record.SourcePath, source, StringComparison.OrdinalIgnoreCase) || !String.Equals(record.DestinationDirectory, destination, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("jobId 已绑定其他来源或目标目录，不能重复使用。");
            if (record.SourceLength < 0 || record.SourceHash == null || !Regex.IsMatch(record.SourceHash, "^[a-f0-9]{64}$") || (record.Mode != "rename" && record.Mode != "copy") || (record.State != "planned" && record.State != "copied" && record.State != "committed" && record.State != "completed"))
                throw new InvalidOperationException("本机任务记录无效，已停止处理。");
            string finalPath = LocalPath(record.FinalPath);
            string temporaryPath = LocalPath(record.TemporaryPath);
            if (!String.Equals(Path.GetDirectoryName(finalPath), destination, StringComparison.OrdinalIgnoreCase) || !String.Equals(Path.GetDirectoryName(temporaryPath), destination, StringComparison.OrdinalIgnoreCase) || !Path.GetFileName(temporaryPath).StartsWith(".download-path-router-" + jobId + "-", StringComparison.Ordinal) || !temporaryPath.EndsWith(".partial", StringComparison.Ordinal))
                throw new InvalidOperationException("任务记录中的目标路径无效。");
            CheckAncestors(finalPath, true);
            CheckAncestors(temporaryPath, true);
        }

        private static void SaveRecord(string path, JobRecord record)
        {
            CheckAncestors(path, true);
            string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                byte[] bytes = Utf8.GetBytes(Json.Serialize(record));
                using (FileStream output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    output.Write(bytes, 0, bytes.Length);
                    output.Flush(true);
                }
                if (File.Exists(path)) File.Replace(temporary, path, null);
                else File.Move(temporary, path);
            }
            finally { try { if (File.Exists(temporary)) File.Delete(temporary); } catch { } }
        }

        private static Dictionary<string, object> MoveSuccess(string finalPath)
        {
            return new Dictionary<string, object> { { "ok", true }, { "finalPath", finalPath } };
        }

        private static Dictionary<string, object> Reveal(Dictionary<string, object> request)
        {
            string path = LocalPath(RequiredString(request, "path"));
            CheckAncestors(path, true);
            if (!File.Exists(path) && !Directory.Exists(path)) throw new FileNotFoundException("文件或目录不存在。");
            string explorer = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe");
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = explorer;
            // Path validation rejects quotes, so the fixed argument grammar cannot be escaped.
            string quotedPath = "\"" + path + (path.EndsWith("\\", StringComparison.Ordinal) ? "\\" : "") + "\"";
            start.Arguments = File.Exists(path) ? "/select," + quotedPath : quotedPath;
            start.UseShellExecute = false;
            Process.Start(start);
            return new Dictionary<string, object> { { "ok", true } };
        }
    }
}
