import * as React from "react"
import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

export interface SpinnerProps extends React.ComponentProps<"svg"> {
  size?: number
}

function Spinner({ className, size = 16, ...props }: SpinnerProps) {
  return (
    <Loader2
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      width={size}
      height={size}
      className={cn("animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
