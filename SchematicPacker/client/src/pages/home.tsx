import { useState, useRef, useCallback, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  Upload,
  Settings,
  Download,
  CheckCircle,
  AlertTriangle,
  FileArchive,
  X,
  RotateCcw,
  Plus,
  Box
} from "lucide-react";

type ConversionState = "upload" | "processing" | "complete" | "error";

interface UploadedFile {
  name: string;
  size: number;
  path: string;
  conversionId: string;
}

interface ProgressData {
  step: string;
  progress: number;
  error?: string;
}

export default function Home() {
  const [state, setState] = useState<ConversionState>("upload");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadedFile, setUploadedFile] = useState<UploadedFile | null>(null);
  const [packName, setPackName] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  // Track page visit on component mount (optional)
  useEffect(() => {
    apiRequest("GET", "/api/visit").catch(() => {});
  }, []);

  // Upload mutation
  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("schematic", file);
      const response = await apiRequest("POST", "/api/upload", formData);
      return response.json();
    },
    onSuccess: (data) => {
      setUploadedFile(data);
      setPackName(data.filename.replace(/\.(schem|schematic)$/i, "_pack"));
      toast({
        title: "File uploaded successfully",
        description: `${data.filename} is ready for conversion.`,
      });
    },
    onError: (error) => {
      toast({
        title: "Upload failed",
        description: error instanceof Error ? error.message : "Failed to upload file",
        variant: "destructive",
      });
    },
  });

  // Conversion mutation
  const convertMutation = useMutation({
    mutationFn: async ({ conversionId, filePath, packName }: {
      conversionId: string;
      filePath: string;
      packName: string;
    }) => {
      const response = await apiRequest("POST", `/api/convert/${conversionId}`, {
        filePath,
        packName,
      });
      return response.json();
    },
    onSuccess: () => {
      setState("processing");
    },
    onError: (error) => {
      setState("error");
      toast({
        title: "Conversion failed",
        description: error instanceof Error ? error.message : "Failed to start conversion",
        variant: "destructive",
      });
    },
  });

  // Progress query
  const { data: progressData } = useQuery<ProgressData>({
    queryKey: ["/api/progress", uploadedFile?.conversionId],
    enabled: state === "processing" && !!uploadedFile?.conversionId,
    refetchInterval: 1000,
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/progress/${uploadedFile?.conversionId}`);
      const data = await response.json();

      if (data.error) {
        setState("error");
        return data;
      }

      if (data.progress >= 100) {
        setState("complete");
      }

      return data;
    },
  });

  const handleFileSelect = (file: File) => {
    const validExtensions = [".schem", ".schematic"];
    const fileExtension = file.name.substring(file.name.lastIndexOf(".")).toLowerCase();

    if (!validExtensions.includes(fileExtension)) {
      toast({
        title: "Invalid file type",
        description: "Please select a .schem or .schematic file.",
        variant: "destructive",
      });
      return;
    }

    if (file.size > 50 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: "Please select a file smaller than 50MB.",
        variant: "destructive",
      });
      return;
    }

    setSelectedFile(file);
    uploadMutation.mutate(file);
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      handleFileSelect(files[0]);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      handleFileSelect(files[0]);
    }
  };

  const handleConvert = () => {
    if (!uploadedFile || !packName.trim()) return;

    convertMutation.mutate({
      conversionId: uploadedFile.conversionId,
      filePath: uploadedFile.path,
      packName: packName.trim(),
    });
  };

  const handleDownload = async () => {
    if (!uploadedFile?.conversionId) return;

    try {
      const response = await fetch(`/api/download/${uploadedFile.conversionId}`);
      if (!response.ok) throw new Error("Download failed");

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${packName}.mcpack`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast({
        title: "Download started",
        description: "Your mcpack file is being downloaded.",
      });
    } catch (error) {
      toast({
        title: "Download failed",
        description: "Failed to download the converted file.",
        variant: "destructive",
      });
    }
  };

  const resetToUpload = () => {
    setState("upload");
    setSelectedFile(null);
    setUploadedFile(null);
    setPackName("");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const formatFileSize = (bytes: number) => {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-50">
      {/* Header */}
      <div className="border-b border-slate-700 bg-slate-800/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-6 py-4">
          <div className="flex items-center space-x-3">
            <Box className="text-blue-500 text-xl" />
            <h1 className="text-xl font-semibold text-slate-50">Originals Schematic → Mcpack</h1>
            <div className="hidden sm:flex items-center space-x-2 ml-auto">
              <span className="text-xs text-slate-400 bg-slate-700 px-2 py-1 rounded">v1.0.0</span>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="space-y-8">
          {/* Main Converter */}
          <Card className="bg-slate-800 border-slate-700">
            <CardContent className="p-8">
              {/* ... all your converter states unchanged ... */}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
