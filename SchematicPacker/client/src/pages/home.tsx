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
  Info,
  Shield,
  Code,
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

  // Track page visit on component mount
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
    const validExtensions = ['.schem', '.schematic'];
    const fileExtension = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
    
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
              <div className="text-center space-y-6">
                
                {/* Upload State */}
                {state === "upload" && (
                  <div className="space-y-6" data-testid="upload-state">
                    <div className="space-y-2">
                      <h2 className="text-2xl font-semibold text-slate-50">Convert Your Schematic</h2>
                      <p className="text-slate-400">Upload a .schem or .schematic file to convert it to Minecraft Bedrock format</p>
                    </div>

                    {/* File Upload Area */}
                    <div className="relative">
                      <div 
                        className={`border-2 border-dashed transition-colors duration-200 rounded-lg p-12 cursor-pointer group ${
                          isDragging 
                            ? 'border-blue-400 bg-blue-500/10' 
                            : 'border-slate-600 hover:border-blue-500 bg-slate-800/50 hover:bg-slate-700/30'
                        }`}
                        onDrop={handleDrop}
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        data-testid="file-upload-area"
                      >
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept=".schem,.schematic"
                          onChange={handleFileInputChange}
                          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                          data-testid="file-input"
                        />
                        
                        <div className="text-center space-y-4">
                          <div className="mx-auto w-16 h-16 bg-slate-700 group-hover:bg-blue-500/20 rounded-full flex items-center justify-center transition-colors duration-200">
                            <Upload className="text-2xl text-slate-400 group-hover:text-blue-400" />
                          </div>
                          
                          <div className="space-y-2">
                            <p className="text-lg font-medium text-slate-300">Drop your schematic file here</p>
                            <p className="text-sm text-slate-500">or click to browse</p>
                            <p className="text-xs text-slate-600">Supports .schem and .schematic files</p>
                          </div>
                        </div>
                      </div>
                      
                      {/* Selected File Display */}
                      {selectedFile && uploadedFile && (
                        <div className="mt-4 p-4 bg-slate-700/50 border border-slate-600 rounded-lg" data-testid="selected-file-display">
                          <div className="flex items-center space-x-3">
                            <FileArchive className="text-blue-400" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-slate-200 truncate">{selectedFile.name}</p>
                              <p className="text-xs text-slate-500">{formatFileSize(selectedFile.size)}</p>
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                resetToUpload();
                              }}
                              className="text-slate-400 hover:text-red-400"
                              data-testid="remove-file-button"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Pack Name Input */}
                    {uploadedFile && (
                      <div className="space-y-2 max-w-md mx-auto">
                        <Label htmlFor="pack-name" className="text-slate-300">Pack Name</Label>
                        <Input
                          id="pack-name"
                          value={packName}
                          onChange={(e) => setPackName(e.target.value)}
                          placeholder="Enter pack name"
                          className="bg-slate-700 border-slate-600 text-slate-200"
                          data-testid="pack-name-input"
                        />
                      </div>
                    )}

                    {/* Convert Button */}
                    <Button
                      onClick={handleConvert}
                      disabled={!uploadedFile || !packName.trim() || uploadMutation.isPending || convertMutation.isPending}
                      className="w-full sm:w-auto px-8 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 disabled:text-slate-500"
                      data-testid="convert-button"
                    >
                      {uploadMutation.isPending ? (
                        <>
                          <Settings className="mr-2 h-4 w-4 animate-spin" />
                          Uploading...
                        </>
                      ) : convertMutation.isPending ? (
                        <>
                          <Settings className="mr-2 h-4 w-4 animate-spin" />
                          Starting...
                        </>
                      ) : (
                        <>
                          <Settings className="mr-2 h-4 w-4" />
                          Convert to Mcpack
                        </>
                      )}
                    </Button>
                  </div>
                )}

                {/* Processing State */}
                {state === "processing" && (
                  <div className="space-y-6" data-testid="processing-state">
                    <div className="space-y-2">
                      <h2 className="text-2xl font-semibold text-slate-50">Processing Your Schematic</h2>
                      <p className="text-slate-400">Please wait while your schematic is being converted...</p>
                    </div>

                    <div className="space-y-6">
                      {/* Animated Processing Icon */}
                      <div className="mx-auto w-20 h-20 bg-blue-500/20 rounded-full flex items-center justify-center">
                        <Settings className="h-8 w-8 text-blue-400 animate-spin-slow" />
                      </div>

                      {/* Progress Bar */}
                      {progressData && (
                        <div className="space-y-3">
                          <div className="flex justify-between text-sm">
                            <span className="text-slate-400" data-testid="progress-step">{progressData.step}</span>
                            <span className="text-slate-400" data-testid="progress-percentage">{progressData.progress}%</span>
                          </div>
                          <Progress value={progressData.progress} className="w-full" data-testid="progress-bar" />
                        </div>
                      )}

                      {/* Processing Steps */}
                      <div className="space-y-3 text-left max-w-md mx-auto">
                        {[
                          { step: "Reading schematic format", completed: (progressData?.progress || 0) > 20 },
                          { step: "Parsing NBT data", completed: (progressData?.progress || 0) > 40 },
                          { step: "Converting block palette", completed: (progressData?.progress || 0) > 60 },
                          { step: "Generating Bedrock structure", completed: (progressData?.progress || 0) > 80 },
                          { step: "Creating Mcpack file", completed: (progressData?.progress || 0) >= 100 },
                        ].map((item, index) => (
                          <div key={index} className="flex items-center space-x-3 text-sm">
                            {item.completed ? (
                              <CheckCircle className="h-4 w-4 text-green-400" />
                            ) : (progressData?.step.toLowerCase().includes(item.step.toLowerCase())) ? (
                              <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <div className="w-4 h-4 rounded-full bg-slate-600" />
                            )}
                            <span className={item.completed ? "text-slate-300" : "text-slate-500"}>
                              {item.step}
                            </span>
                          </div>
                        ))}
                      </div>

                      {/* Cancel Button */}
                      <Button
                        variant="ghost"
                        onClick={resetToUpload}
                        className="text-slate-400 hover:text-red-400"
                        data-testid="cancel-button"
                      >
                        <X className="mr-1 h-4 w-4" />
                        Cancel Processing
                      </Button>
                    </div>
                  </div>
                )}

                {/* Success State */}
                {state === "complete" && (
                  <div className="space-y-6" data-testid="success-state">
                    <div className="space-y-2">
                      <div className="mx-auto w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mb-4">
                        <CheckCircle className="h-8 w-8 text-green-400" />
                      </div>
                      <h2 className="text-2xl font-semibold text-slate-50">Conversion Complete!</h2>
                      <p className="text-slate-400">Your schematic has been successfully converted to Minecraft Bedrock format</p>
                    </div>

                    <div className="space-y-4">
                      <div className="bg-slate-700/50 border border-slate-600 rounded-lg p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-3">
                            <FileArchive className="text-green-400" />
                            <div>
                              <p className="text-sm font-medium text-slate-200" data-testid="output-filename">
                                {packName}.mcpack
                              </p>
                              <p className="text-xs text-slate-500">Ready for download</p>
                            </div>
                          </div>
                          <Button
                            onClick={handleDownload}
                            className="bg-green-600 hover:bg-green-700 text-white"
                            data-testid="download-button"
                          >
                            <Download className="mr-2 h-4 w-4" />
                            Download
                          </Button>
                        </div>
                      </div>

                      {/* Convert Another Button */}
                      <Button
                        variant="secondary"
                        onClick={resetToUpload}
                        className="w-full sm:w-auto bg-slate-700 hover:bg-slate-600 text-slate-200"
                        data-testid="convert-another-button"
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        Convert Another File
                      </Button>
                    </div>
                  </div>
                )}

                {/* Error State */}
                {state === "error" && (
                  <div className="space-y-6" data-testid="error-state">
                    <div className="space-y-2">
                      <div className="mx-auto w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mb-4">
                        <AlertTriangle className="h-8 w-8 text-red-400" />
                      </div>
                      <h2 className="text-2xl font-semibold text-slate-50">Conversion Failed</h2>
                      <p className="text-slate-400">There was an error processing your schematic file</p>
                    </div>

                    {/* Error Details */}
                    <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-left">
                      <div className="space-y-2">
                        <p className="text-sm font-medium text-red-300">Error Details:</p>
                        <p className="text-sm text-red-200" data-testid="error-message">
                          {progressData?.error || "Unknown error occurred during conversion."}
                        </p>
                      </div>
                    </div>

                    {/* Retry Button */}
                    <Button
                      onClick={resetToUpload}
                      className="w-full sm:w-auto bg-blue-600 hover:bg-blue-700 text-white"
                      data-testid="retry-button"
                    >
                      <RotateCcw className="mr-2 h-4 w-4" />
                      Try Again
                    </Button>
                  </div>
                )}

              </div>
            </CardContent>
          </Card>

        </div>
        
      </div>
    </div>
  );
}
